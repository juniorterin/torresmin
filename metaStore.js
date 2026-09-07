"use strict";
const fs   = require("fs");
const path = require("path");
const { getPgPool } = require("./dbPool");

// Metadados de exibição dos catálogos curados, guardados por IMDb id.
//
// Por que existe: o store de catálogos (catalogs.js) guarda só a lista de ids.
// Título, pôster, sinopse e nota vinham do Cinemeta a cada montagem, o que
// tornava a home refém de um serviço externo — sob carga ele devolve 504 e o
// filme some do catálogo. Com os metadados no banco, servir um catálogo não
// depende mais de rede nenhuma.
//
// O dado é congelado de propósito: catálogo curado é uma lista fixa, então
// pôster e sinopse desatualizarem não é problema. Para atualizar, roda-se
// `node scripts/buildMetaStore.js` de novo.
//
// Guardado por id, e não dentro de cada catálogo, porque há muita repetição —
// 2903 ids únicos para 4854 entradas. O mesmo filme aparece em vários
// catálogos e a ficha dele fica uma vez só.
//
// Mesmo padrão dual-backend de catalogs.js/configStore.js/accessKeys.js.

function getMetaDbUrl() {
  return process.env.META_DATABASE_URL || process.env.CATALOGS_DATABASE_URL || process.env.CONFIG_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
}
function getMetaDbTable() {
  const table = process.env.META_DATABASE_TABLE || "torresmin_meta";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) throw new Error("META_DATABASE_TABLE inválida");
  return table;
}
function shouldUseMetaDb() {
  return !!getMetaDbUrl();
}

// ─── Postgres ────────────────────────────────────────────────────────────────
let metaPgInit = null;

async function ensureMetaDb() {
  const url = getMetaDbUrl();
  if (!shouldUseMetaDb()) return null;
  const pool = getPgPool(url);
  if (!pool) return null;
  const table = getMetaDbTable();
  if (!metaPgInit) {
    metaPgInit = pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((err) => {
      metaPgInit = null;
      console.error(`[META] Falha ao inicializar a tabela Postgres '${table}':`, err?.message || err);
      throw err;
    });
  }
  await metaPgInit;
  return pool;
}

async function dbGetMany(ids) {
  const pool = await ensureMetaDb();
  if (!pool) return new Map();
  const table = getMetaDbTable();
  const res = await pool.query(`SELECT id, payload FROM ${table} WHERE id = ANY($1)`, [ids]);
  return new Map(res.rows.map(r => [r.id, r.payload]));
}

async function dbUpsert(id, payload) {
  const pool = await ensureMetaDb();
  if (!pool) return false;
  const table = getMetaDbTable();
  await pool.query(
    `INSERT INTO ${table} (id, payload) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [id, payload]
  );
  return true;
}

async function dbCount() {
  const pool = await ensureMetaDb();
  if (!pool) return 0;
  const res = await pool.query(`SELECT COUNT(*)::int AS n FROM ${getMetaDbTable()}`);
  return res.rows[0]?.n || 0;
}

// ─── Arquivo ─────────────────────────────────────────────────────────────────
function getDataDir() {
  return process.env.CONFIG_DATA_DIR || "/data";
}
function getFilePath() {
  return path.join(getDataDir(), "torresmin_meta.json");
}

let fileCache = null;

function fileLoad() {
  if (fileCache) return fileCache;
  try {
    fileCache = JSON.parse(fs.readFileSync(getFilePath(), "utf8"));
  } catch {
    fileCache = {};
  }
  return fileCache;
}

function fileSave(store) {
  fileCache = store;
  const dir = getDataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(getFilePath(), JSON.stringify(store));
}

// ─── API ─────────────────────────────────────────────────────────────────────

// Busca em lote: o caminho quente é montar um catálogo inteiro de uma vez.
async function getMetas(ids) {
  if (!Array.isArray(ids) || !ids.length) return new Map();
  if (shouldUseMetaDb()) {
    try { return await dbGetMany(ids); } catch { return new Map(); }
  }
  const store = fileLoad();
  const out = new Map();
  for (const id of ids) if (store[id]) out.set(id, store[id]);
  return out;
}

async function saveMeta(id, payload) {
  if (shouldUseMetaDb()) return await dbUpsert(id, payload);
  const store = fileLoad();
  store[id] = payload;
  fileSave(store);
  return true;
}

// Grava em lote — no backend de arquivo, uma escrita só em vez de uma por item.
async function saveMetas(entries) {
  if (shouldUseMetaDb()) {
    for (const [id, payload] of entries) await dbUpsert(id, payload);
    return entries.length;
  }
  const store = fileLoad();
  for (const [id, payload] of entries) store[id] = payload;
  fileSave(store);
  return entries.length;
}

async function countMetas() {
  if (shouldUseMetaDb()) {
    try { return await dbCount(); } catch { return 0; }
  }
  return Object.keys(fileLoad()).length;
}

module.exports = {
  getMetas,
  saveMeta,
  saveMetas,
  countMetas,
  shouldUseMetaDb,
};
