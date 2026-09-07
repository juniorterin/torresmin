"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { enrichMetaPtBr } = require("../metadata");
const { getMetas, saveMetas, countMetas, shouldUseMetaDb } = require("../metaStore");

// Popula o store de metadados a partir dos ids que estão nos catálogos.
//
//   node scripts/buildMetaStore.js            # só o que falta
//   node scripts/buildMetaStore.js --refresh  # refaz tudo, inclusive o que já existe
//
// Roda com o mesmo ambiente do app (CONFIG_DATA_DIR/CONFIG_DATABASE_URL, e
// TMDB_API_KEY para a tradução pt-BR).
//
// Depois disso, routes/catalog.js serve os catálogos direto do banco, sem
// depender do Cinemeta em tempo de request. É o que elimina a intermitência:
// os 504 esporádicos do Cinemeta deixam de derrubar filmes da home.
//
// A sinopse e o título vêm em pt-BR quando o TMDB tem tradução; sem
// TMDB_API_KEY configurada, enrichMetaPtBr é no-op e sobra o texto em inglês
// (o script avisa nesse caso).

const SEED_DIR = path.join(__dirname, "seed-data");
const REFRESH = process.argv.includes("--refresh");
const CONCURRENCY = 6;

function idsFromSeed() {
  const ids = new Set();
  for (const f of fs.readdirSync(SEED_DIR).filter(f => f.endsWith(".json"))) {
    for (const e of JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), "utf8"))) {
      if (/^tt\d{5,10}$/.test(e.imdbId || "")) ids.add(e.imdbId);
    }
  }
  return [...ids];
}

async function fetchOne(imdbId) {
  // Duas tentativas: o Cinemeta devolve 504/503 esporádicos sob carga, e uma
  // falha transitória não pode virar filme faltando no catálogo.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`, { timeout: 10000 });
      const meta = r.data?.meta;
      if (!meta || !meta.name) return null;

      const enriched = await enrichMetaPtBr(meta, imdbId, "movie");
      return {
        id:          imdbId,
        type:        "movie",
        name:        enriched.name,
        poster:      enriched.poster,
        background:  enriched.background,
        description: enriched.description,
        releaseInfo: enriched.releaseInfo,
        imdbRating:  enriched.imdbRating,
        genres:      enriched.genres,
      };
    } catch (err) {
      if (err.response && err.response.status === 404) return null;
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

(async () => {
  const temTmdb = !!(process.env.TMDB_API_KEY || process.env.TMDB_BEARER_TOKEN);
  console.log(`[meta] backend: ${shouldUseMetaDb() ? "Postgres" : "arquivo"} | pt-BR: ${temTmdb ? "sim (TMDB)" : "NÃO — sem TMDB_API_KEY, fica em inglês"}`);

  const todos = idsFromSeed();
  const existentes = REFRESH ? new Map() : await getMetas(todos);
  const alvo = todos.filter(id => !existentes.has(id));

  console.log(`[meta] ${todos.length} ids nos catálogos | ${existentes.size} já no banco | ${alvo.length} a buscar`);
  if (!alvo.length) {
    console.log(`[meta] nada a fazer. Use --refresh para reprocessar tudo.`);
    process.exit(0);
  }

  let ok = 0, falhou = 0, gravados = 0;
  const lote = [];

  await mapLimit(alvo, CONCURRENCY, async (id, i) => {
    const meta = await fetchOne(id);
    if (meta) { lote.push([id, meta]); ok++; } else { falhou++; }

    // Grava de 200 em 200 para não perder tudo se a execução for interrompida.
    if (lote.length >= 200) {
      const chunk = lote.splice(0, lote.length);
      await saveMetas(chunk);
      gravados += chunk.length;
      console.log(`[meta] ${gravados}/${alvo.length} gravados (${falhou} sem metadado)`);
    }
  });

  if (lote.length) { await saveMetas(lote); gravados += lote.length; }

  console.log(`[meta] concluído — ${ok} gravados, ${falhou} sem metadado no Cinemeta.`);
  console.log(`[meta] store agora tem ${await countMetas()} fichas.`);
  process.exit(0);
})();
