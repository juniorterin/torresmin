const express = require("express");
const axios = require("axios");
const { ENV } = require("../constants");
const { rc } = require("../cache");
const { normalizeImdbId } = require("../scoring");
const { enrichMetaPtBr } = require("../metadata");
const { getCatalog } = require("../catalogs");
const { isPtBrRequest } = require("../routeHelpers");

const router = express.Router();

// Catálogos curados mudam raramente — cache longo, mas catalogs.js invalida
// na hora (rc.del) sempre que o admin edita um catálogo, então isso não vira
// "editei e não apareceu por 6h".
const CATALOG_CACHE_TTL = 6 * 3600;
const CATALOG_PAGE_SIZE = 100;

// Ao abrir a home, o Stremio pede vários catálogos de uma vez. Sem limite por
// catálogo, cada um disparava uma requisição por item (até ~100) e o total
// passava de mil conexões simultâneas ao Cinemeta — que respondia com timeout,
// os itens viravam null e o catálogo era montado vazio.
const META_CONCURRENCY = 8;

// Metadado de filme muda muito pouco, e o mesmo título aparece em vários
// catálogos (5848 itens em 69 listas, com bastante repetição). Guardar por id
// faz o segundo catálogo que contém aquele filme sair de graça.
const META_CACHE_TTL = 7 * 24 * 3600;

// Só vale gravar o catálogo montado por 6h se ele ficou realmente completo. Um
// build degradado gravado com TTL longo era o que fazia o catálogo aparecer
// vazio e continuar vazio pelo resto do dia.
//
// O limite era 0.8 e ficou frouxo demais: um catálogo de 72 itens montou com
// 60 (83%), passou como completo e ficou 6h assim — quando na verdade 71 dos
// 72 resolvem, e as perdas eram 504 transitórios do Cinemeta sob carga.
const CATALOG_MIN_SUCCESS_RATIO = 0.95;
const CATALOG_DEGRADED_TTL = 120;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// Uma tentativa só perdia itens à toa: sob carga o Cinemeta devolve 504/503
// esporádicos, e cada um desses derrubava um filme do catálogo. Medindo um
// catálogo de 72 itens, 71 resolvem — as perdas eram todas transitórias.
async function fetchMeta(type, imdbId) {
  const key = `cinemeta:${type}:${imdbId}`;
  const hit = await rc.get(key).catch(() => null);
  if (hit) { try { return JSON.parse(hit); } catch { /* refaz abaixo */ } }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 6000 });
      const meta = r.data?.meta;
      if (meta) {
        rc.set(key, JSON.stringify(meta), META_CACHE_TTL).catch(() => {});
        return meta;
      }
      return null;                                // respondeu e não tem o filme
    } catch (err) {
      // 404 é resposta, não falha: não adianta repetir.
      if (err.response && err.response.status === 404) return null;
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }
  }
  return null;
}

router.get("/:userConfig/catalog/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  if (!id.startsWith("curated_")) return res.json({ metas: [] });
  const slug = id.slice("curated_".length);

  try {
    const catalog = await getCatalog(slug);
    if (!catalog || catalog.type !== type) return res.json({ metas: [] });

    const ptBr = isPtBrRequest(req);
    const cacheKey = `curatedcatalog:${slug}:${ptBr ? "pt" : "en"}`;
    let metas = null;
    const cached = await rc.get(cacheKey).catch(() => null);
    if (cached) {
      try { metas = JSON.parse(cached); } catch { metas = null; }
    }

    if (!metas) {
      metas = (await mapLimit(catalog.items, META_CONCURRENCY, async ({ imdbId }) => {
        try {
          const meta = await fetchMeta(type, imdbId);
          if (!meta) return null;
          const enriched = ptBr ? await enrichMetaPtBr(meta, imdbId, type) : meta;
          return {
            id:          imdbId,
            type,
            name:        enriched.name,
            poster:      enriched.poster,
            background:  enriched.background,
            description: enriched.description,
            releaseInfo: enriched.releaseInfo,
            imdbRating:  enriched.imdbRating,
            genres:      enriched.genres,
          };
        } catch { return null; }
      })).filter(m => m && m.name);

      // Build incompleto não pode ocupar as próximas 6h: guarda por 2min só para
      // não martelar o Cinemeta, e tenta montar completo de novo em seguida.
      const total = catalog.items.length;
      const complete = total === 0 || metas.length / total >= CATALOG_MIN_SUCCESS_RATIO;
      if (!complete) {
        console.warn(`[Catalogo] ${slug}: apenas ${metas.length}/${total} itens resolvidos — cache curto (${CATALOG_DEGRADED_TTL}s)`);
      }
      rc.set(cacheKey, JSON.stringify(metas), complete ? CATALOG_CACHE_TTL : CATALOG_DEGRADED_TTL).catch(() => {});
    }

    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    res.json({ metas: metas.slice(skip, skip + CATALOG_PAGE_SIZE) });
  } catch {
    res.json({ metas: [] });
  }
});

router.get("/:userConfig/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  try {
    const targetType = type === "series" ? "series" : "movie";
    const cleanId = normalizeImdbId(id) || id;
    const r = await axios.get(`https://v3-cinemeta.strem.io/meta/${targetType}/${cleanId}.json`, { timeout: 5000 });
    const payload = r.data || { meta: null };
    if (payload.meta && isPtBrRequest(req)) payload.meta = await enrichMetaPtBr(payload.meta, cleanId, targetType);
    return res.json(payload);
  } catch {
    // Fallback: tenta buscar nos addons de scrap
    if (ENV.scrapManifests.length) {
      for (const manifestUrl of ENV.scrapManifests) {
        try {
          const base = manifestUrl.replace(/\/manifest\.json$/i, "");
          const r = await axios.get(`${base}/meta/${type}/${id}.json`, { timeout: 5000 });
          if (r.data?.meta) return res.json(r.data);
        } catch {}
      }
    }
    return res.json({ meta: null });
  }
});

module.exports = router;
