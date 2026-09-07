"use strict";
const fs   = require("fs");
const path = require("path");
const { getPgPool } = require("./dbPool");
const { rc } = require("./cache");

// Catálogos curados (Criterion Collection, Sight & Sound etc.) — ao vivo,
// editáveis pelo /admin, não um seed estático. Mesmo padrão dual-backend de
// accessKeys.js/configStore.js.

function getCatalogsDbUrl() {
  return process.env.CATALOGS_DATABASE_URL || process.env.CONFIG_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
}
function getCatalogsDbTable() {
  const table = process.env.CATALOGS_DATABASE_TABLE || "torresmin_catalogs";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) throw new Error("CATALOGS_DATABASE_TABLE inválida");
  return table;
}
function shouldUseCatalogsDb() {
  return !!getCatalogsDbUrl();
}

// ─── Postgres ────────────────────────────────────────────────────────────────
let catalogsPgInit = null;

async function ensureCatalogsDb() {
  const url = getCatalogsDbUrl();
  if (!shouldUseCatalogsDb()) return null;
  const pool = getPgPool(url);
  if (!pool) return null;
  const table = getCatalogsDbTable();
  if (!catalogsPgInit) {
    catalogsPgInit = pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((err) => {
      catalogsPgInit = null;
      console.error(`[CATALOGS] Falha ao inicializar a tabela Postgres '${table}':`, err?.message || err);
      throw err;
    });
  }
  await catalogsPgInit;
  return pool;
}

async function dbList() {
  const pool = await ensureCatalogsDb();
  if (!pool) return null;
  const table = getCatalogsDbTable();
  const r = await pool.query(`SELECT payload FROM ${table} ORDER BY (payload->>'order')::int NULLS LAST, created_at ASC`);
  return r.rows.map(row => row.payload);
}

async function dbGet(id) {
  const pool = await ensureCatalogsDb();
  if (!pool) return null;
  const table = getCatalogsDbTable();
  const r = await pool.query(`SELECT payload FROM ${table} WHERE id = $1`, [id]);
  return r.rows[0]?.payload || null;
}

async function dbUpsert(record) {
  const pool = await ensureCatalogsDb();
  if (!pool) return false;
  const table = getCatalogsDbTable();
  await pool.query(
    `INSERT INTO ${table} (id, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [record.id, JSON.stringify(record)]
  );
  return true;
}

async function dbDelete(id) {
  const pool = await ensureCatalogsDb();
  if (!pool) return false;
  const table = getCatalogsDbTable();
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return true;
}

// ─── Arquivo ─────────────────────────────────────────────────────────────────
const CATALOGS_FILE = (() => {
  let dir = process.env.CONFIG_DATA_DIR || "";
  if (!dir || /^[a-z][a-z0-9+.-]*:\/\//i.test(dir)) dir = "/data";
  return path.join(dir, "torresmin_catalogs.json");
})();

function fileLoad() {
  try {
    if (!fs.existsSync(CATALOGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(CATALOGS_FILE, "utf8"));
  } catch { return {}; }
}
function fileSave(store) {
  try {
    const dir = path.dirname(CATALOGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CATALOGS_FILE, JSON.stringify(store), "utf8");
  } catch (err) {
    console.error(`[CATALOGS] Falha ao salvar catálogos: ${err.message}`);
  }
}
let _store = null;
function store() {
  if (!_store) _store = fileLoad();
  return _store;
}

// ─── API pública ─────────────────────────────────────────────────────────────
function validateSlug(id) {
  if (!/^[a-z0-9_-]{1,40}$/.test(id || "")) throw new Error("Id de catálogo inválido (use letras minúsculas, números, - ou _)");
}
function validateImdbId(imdbId) {
  if (!/^tt\d{5,10}$/.test(imdbId || "")) throw new Error("IMDb id inválido (formato tt1234567)");
}

async function saveCatalog(record) {
  if (shouldUseCatalogsDb()) return await dbUpsert(record);
  const s = store();
  s[record.id] = record;
  fileSave(s);
  return true;
}

function bustCache(id) {
  rc.del(`curatedcatalog:${id}:pt`).catch(() => {});
  rc.del(`curatedcatalog:${id}:en`).catch(() => {});
}

async function listCatalogs() {
  if (shouldUseCatalogsDb()) {
    const rows = await dbList();
    return rows || [];
  }
  return Object.values(store()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

async function getCatalog(id) {
  if (!id) return null;
  if (shouldUseCatalogsDb()) return await dbGet(id);
  return store()[id] || null;
}

async function createCatalog(id, name, type) {
  validateSlug(id);
  if (await getCatalog(id)) throw new Error(`Catálogo '${id}' já existe`);
  const existing = await listCatalogs();
  const record = {
    id,
    name: String(name || id).trim().slice(0, 120),
    type: type === "series" ? "series" : "movie",
    order: existing.length,
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveCatalog(record);
  return record;
}

async function renameCatalog(id, name) {
  const record = await getCatalog(id);
  if (!record) return null;
  record.name = String(name || record.name).trim().slice(0, 120);
  record.updatedAt = Date.now();
  await saveCatalog(record);
  bustCache(id);
  return record;
}

async function deleteCatalog(id) {
  if (shouldUseCatalogsDb()) await dbDelete(id);
  else { const s = store(); delete s[id]; fileSave(s); }
  bustCache(id);
  return true;
}

async function addCatalogItem(id, imdbId) {
  validateImdbId(imdbId);
  const record = await getCatalog(id);
  if (!record) throw new Error(`Catálogo '${id}' não encontrado`);
  if (!record.items.some(it => it.imdbId === imdbId)) {
    record.items.push({ imdbId, addedAt: Date.now() });
    record.updatedAt = Date.now();
    await saveCatalog(record);
    bustCache(id);
  }
  return record;
}

// Troca a lista inteira de itens de uma vez, criando o catálogo se não existir.
//
// Existe porque addCatalogItem só acrescenta: para fazer o store espelhar uma
// lista de origem (o caso do scripts/seedCatalogs.js --replace) seria preciso
// diffar e remover item a item, cada remoção gravando o registro de novo. Aqui
// é uma gravação só, e os metadados do catálogo (nome, tipo, posição na home,
// data de criação) são preservados quando ele já existe.
//
// Destrutivo por natureza: o que não vier em `imdbIds` deixa de existir.
async function replaceCatalogItems(id, imdbIds, meta = {}) {
  validateSlug(id);
  const current = await getCatalog(id);
  const now = Date.now();

  const items = [];
  const seen = new Set();
  for (const imdbId of imdbIds) {
    validateImdbId(imdbId);
    if (seen.has(imdbId)) continue;
    seen.add(imdbId);
    // Mantém o addedAt de quem já estava lá, para o histórico não zerar.
    const prev = current?.items?.find(it => it.imdbId === imdbId);
    items.push({ imdbId, addedAt: prev?.addedAt || now });
  }

  const record = {
    id,
    name: current?.name || String(meta.name || id).trim().slice(0, 120),
    type: current?.type || (meta.type === "series" ? "series" : "movie"),
    order: current?.order ?? (await listCatalogs()).length,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    items,
  };

  await saveCatalog(record);
  bustCache(id);
  return record;
}

async function removeCatalogItem(id, imdbId) {
  const record = await getCatalog(id);
  if (!record) throw new Error(`Catálogo '${id}' não encontrado`);
  record.items = record.items.filter(it => it.imdbId !== imdbId);
  record.updatedAt = Date.now();
  await saveCatalog(record);
  bustCache(id);
  return record;
}

module.exports = {
  listCatalogs,
  getCatalog,
  createCatalog,
  renameCatalog,
  deleteCatalog,
  addCatalogItem,
  removeCatalogItem,
  replaceCatalogItems,
};
