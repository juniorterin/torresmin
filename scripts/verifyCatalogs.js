"use strict";
const fs = require("fs");
const path = require("path");

// Confere cada linha de scripts/seed-data/*.json contra o IMDb: o imdbId
// gravado aponta mesmo para aquele título, naquele ano?
//
//   node scripts/verifyCatalogs.js                    # tudo
//   node scripts/verifyCatalogs.js world_brazil       # só alguns catálogos
//   node scripts/verifyCatalogs.js --fresh            # ignora o cache local
//
// Fonte: o endpoint de sugestão do próprio imdb.com, o mesmo que alimenta o
// autocomplete do site. Não pede chave e devolve título (l), ano (y) e tipo
// (q). É preferível ao Cinemeta aqui por dois motivos: o Cinemeta responde
// /meta/movie/<id> com dados de OUTRO filme quando o id é de série (tt0080196
// volta como "Million Dollar Mermaid" em vez de Berlin Alexanderplatz), e não
// informa se o título é longa, curta ou série.
//
// ARMADILHA que este script trata: id inexistente não devolve erro nem lista
// vazia — devolve o resultado mais parecido. Consultar tt9999999999 responde
// "Space: 1999". Por isso só vale a entrada cujo id devolvido seja idêntico ao
// consultado; qualquer outra coisa é id quebrado.

const SEED_DIR = path.join(__dirname, "seed-data");
const CACHE_FILE = path.join(__dirname, ".imdb-cache.json");

// O endpoint do IMDb corta por volume: com 6 consultas em paralelo ele começou
// a responder 429 depois de algumas centenas. Sequencial e espaçado, aguenta a
// rodada inteira. São ~4900 entradas, então a passada completa leva ~25min —
// o cache faz as seguintes serem rápidas.
const CONCURRENCY = 1;
const REQUEST_SPACING_MS = 300;
const THROTTLE_BACKOFF_MS = 5000;
let rateLimited = 0;

const argv = process.argv.slice(2);
const FRESH = argv.includes("--fresh");
const ONLY = argv.filter(a => !a.startsWith("--"));

let cache = {};
if (!FRESH) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* começa vazio */ }
}

// Devolve o metadado, `null` só quando o IMDb respondeu de verdade e não tem
// aquele id, ou `undefined` quando não deu pra checar (429, 5xx, rede).
//
// Essa distinção é o ponto mais importante do script. Na primeira versão eu
// tratava falha de consulta como "id inexistente" E gravava isso no cache: o
// IMDb passou a responder 429 no meio de uma rodada de 4855 consultas e o
// relatório saiu com 2703 "ids quebrados" que na verdade estavam corretos —
// inclusive catálogos que eu já sabia limpos. Falha nunca é conclusão, e
// nunca vai pro cache.
async function imdbLookup(imdbId) {
  if (cache[imdbId] !== undefined) return cache[imdbId];

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`https://v2.sg.media-imdb.com/suggestion/t/${imdbId}.json`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (res.status === 429 || res.status >= 500) {
        rateLimited++;
        await sleep(THROTTLE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 404) { cache[imdbId] = null; return null; }
      if (!res.ok) { await sleep(1000 * (attempt + 1)); continue; }

      const body = await res.json();
      // Só o casamento exato conta — ver a armadilha no cabeçalho.
      const hit = (body.d || []).find(x => x.id === imdbId);
      const out = hit ? { title: hit.l || "", year: hit.y || null, kind: hit.q || "", cast: hit.s || "" } : null;
      cache[imdbId] = out;
      return out;
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return undefined;                               // não checado — não cacheia
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// O seed guarda com frequência o título original ou traduzido enquanto o IMDb
// guarda o canônico ("Os Fuzis" / "The Guns"). Divergência de título sozinha,
// portanto, não é defeito — só vira suspeita quando o ano também não bate.
const norm = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/&/g, " and ")
  .replace(/\bcolour\b/g, "color").replace(/\bflavour\b/g, "flavor")
  .replace(/[^a-z0-9]+/g, " ").trim();

function titlesMatch(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const ta = new Set(A.split(" ").filter(w => w.length > 2));
  const tb = new Set(B.split(" ").filter(w => w.length > 2));
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
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
  const files = fs.readdirSync(SEED_DIR)
    .filter(f => f.endsWith(".json"))
    .filter(f => !ONLY.length || ONLY.includes(path.basename(f, ".json")));

  const broken = [], yearOff = [], notFeature = [], translated = [], unchecked = [];
  let total = 0, ok = 0;

  for (const file of files) {
    const slug = path.basename(file, ".json");
    const entries = JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
    total += entries.length;

    const rows = await mapLimit(entries, CONCURRENCY, async (e) => {
      const meta = await imdbLookup(e.imdbId);
      await sleep(REQUEST_SPACING_MS);
      if (meta === undefined) return { kind: "unchecked", slug, ...e };
      if (meta === null) return { kind: "broken", slug, ...e };

      const seedYear = Number(String(e.year || "").match(/\d{4}/)?.[0]);
      const yearGap = seedYear && meta.year ? Math.abs(seedYear - meta.year) : null;
      const sameTitle = titlesMatch(e.title, meta.title);

      // Curta, série ou vídeo dentro de um catálogo de longas é problema de
      // conteúdo, não de id — reportado à parte para não virar ruído.
      const isFeature = /feature/i.test(meta.kind);

      if (!sameTitle && yearGap !== null && yearGap > 1) {
        return { kind: "yearOff", slug, ...e, imdbTitle: meta.title, imdbYear: meta.year, imdbKind: meta.kind };
      }
      if (yearGap !== null && yearGap > 1) {
        return { kind: "yearOff", slug, ...e, imdbTitle: meta.title, imdbYear: meta.year, imdbKind: meta.kind };
      }
      if (!isFeature) {
        return { kind: "notFeature", slug, ...e, imdbTitle: meta.title, imdbYear: meta.year, imdbKind: meta.kind };
      }
      if (!sameTitle) {
        return { kind: "translated", slug, ...e, imdbTitle: meta.title, imdbYear: meta.year };
      }
      return null;
    });

    let bad = 0;
    for (const r of rows) {
      if (!r) { ok++; continue; }
      if (r.kind === "unchecked") { unchecked.push(r); }
      else if (r.kind === "broken") { broken.push(r); bad++; }
      else if (r.kind === "yearOff") { yearOff.push(r); bad++; }
      else if (r.kind === "notFeature") { notFeature.push(r); bad++; }
      else { translated.push(r); ok++; }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    console.log(`${slug.padEnd(32)} ${String(entries.length).padStart(4)} entradas  ${bad ? `${bad} a revisar` : "ok"}`);
  }

  const report = { total, ok, broken, yearOff, notFeature, translated, unchecked };
  fs.writeFileSync(path.join(__dirname, "catalog-report.json"), JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(64)}`);
  console.log(`entradas conferidas : ${total}`);
  console.log(`id confere          : ${ok}  (inclui ${translated.length} com título traduzido, ano batendo)`);
  console.log(`ID QUEBRADO         : ${broken.length}  (não existe no IMDb)`);
  console.log(`ANO DIVERGENTE      : ${yearOff.length}  (id aponta para outro filme)`);
  console.log(`não é longa-metragem: ${notFeature.length}  (curta, série ou vídeo)`);
  if (unchecked.length) {
    console.log(`\nNÃO VERIFICADO      : ${unchecked.length}  — o IMDb limitou por volume (${rateLimited} respostas 429/5xx).`);
    console.log(`                      Essas entradas NÃO são defeito: rode de novo para conferi-las.`);
  }

  const show = (label, list, n = 15) => {
    if (!list.length) return;
    console.log(`\n--- ${label} ---`);
    list.slice(0, n).forEach(x => console.log(
      `  [${x.slug}] "${x.title}" (${x.year}) ${x.imdbId}` +
      (x.imdbTitle ? ` -> IMDb: "${x.imdbTitle}" (${x.imdbYear}${x.imdbKind ? ", " + x.imdbKind : ""})` : "")
    ));
    if (list.length > n) console.log(`  ... e mais ${list.length - n}`);
  };
  show("ID QUEBRADO", broken);
  show("ANO DIVERGENTE", yearOff);
  show("NÃO É LONGA", notFeature);

  console.log(`\nrelatório completo: scripts/catalog-report.json`);
})();
