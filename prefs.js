"use strict";

const { EXCLUDE_FILTER_KEYS } = require("./scoring");

// ─── Helpers de sanitização ───────────────────────────────────────────────────
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanString(value, max = 300) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

// Como cleanString, mas preserva quebras de linha — usado pelos templates de
// formatação, onde cada linha é uma unidade própria (placeholder vazio = linha some).
function cleanTemplate(value, max = 800) {
  return String(value || "").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);
}

function cleanStringArray(value, maxItems = 100, maxLen = 120) {
  if (!Array.isArray(value)) return [];
  return value.map(v => cleanString(v, maxLen)).filter(Boolean).slice(0, maxItems);
}

// A tela de configuração expõe só dois seletores — "agrupar por" e "ordenar
// por" — em vez da cadeia completa de critérios. Palavra-chave de boost fica
// sempre em primeiro (é o que faz um "furam a fila" continuar funcionando), o
// escolhido em cada seletor entra em seguida, e o resto da cadeia antiga
// completa o desempate na mesma ordem de sempre — sem regressão de qualidade
// de ordenação pra quem não mexer em nada.
const GROUP_KEYS = ["language", "resolution", "quality", "indexer"];
const ORDER_KEYS = ["seeders", "size"];
const DEFAULT_GROUP_BY = "language";
const DEFAULT_ORDER_BY = "seeders";
const SORT_FALLBACK_ORDER = ["language", "resolution", "quality", "size", "seeders", "indexer"];

function buildSortBy(groupBy, orderBy) {
  const rest = SORT_FALLBACK_ORDER.filter(k => k !== groupBy && k !== orderBy);
  return ["keyword", groupBy, orderBy, ...rest];
}

// Aceita "2GB", "500 MB", "1.5gb"... (sem unidade = GB, já que é a escala
// mais comum pra falar de tamanho de vídeo). Retorno 0 = sem limite.
function parseSizeToBytes(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const m = raw.match(/^([\d.,]+)\s*(gb|mb|kb|g|m|k)?$/i);
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = (m[2] || "gb").toLowerCase()[0];
  const mult = unit === "g" ? 1e9 : unit === "m" ? 1e6 : 1e3;
  return Math.round(n * mult);
}

function validateServiceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > 300) throw new Error("URL muito longa");
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL deve usar http ou https");
  if (parsed.username || parsed.password) throw new Error("URL não deve conter credenciais");
  return parsed.toString().replace(/\/+$/, "");
}

function safeServiceUrl(value) {
  try { return validateServiceUrl(value); }
  catch { return ""; }
}

// ─── Prefs padrão e normalização ─────────────────────────────────────────────
function defaultPrefs() {
  return {
    indexers:        ["all"],
    categories:      ["movie", "series"],
    weights:         { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5 },
    maxResults:      20,
    slowThreshold:   4000,
    skipBadReleases: true,
    priorityLang:    "pt-br",
    onlyDubbed:      false,
    dedupe:          true,
    keywordBoost:           "",
    priorityIndexers:       [],
    maxResultsPerIndexer:   0,
    enableCatalog:   true,
    catalogIds:      ["all"],
    rssIndexers:     [],
    token:           "",
    accessKey:       "",
    nameTemplate:        "",
    descriptionTemplate: "",
    sortGroupBy:         DEFAULT_GROUP_BY,
    sortOrderBy:         DEFAULT_ORDER_BY,
    excludeFilters:      [],
    videoSizeLimit:      "",
  };
}

function sanitizeUserPrefs(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};

  const rawIndexers = Array.isArray(src.indexers)
    ? src.indexers
    : String(src.indexers || "").split(",").map(s => s.trim()).filter(Boolean);
  const indexers = cleanStringArray(rawIndexers, 200, 120);
  out.indexers = indexers.length ? indexers : ["all"];
  const categories = cleanStringArray(src.categories, 10, 20).filter(c => ["movie", "series", "anime"].includes(c));
  out.categories = categories.length ? [...new Set(categories)] : ["movie", "series"];

  if (src.weights && typeof src.weights === "object" && !Array.isArray(src.weights)) {
    out.weights = {
      language: clampNumber(src.weights.language, 40, 0, 100),
      resolution: clampNumber(src.weights.resolution, 30, 0, 100),
      seeders: clampNumber(src.weights.seeders, 20, 0, 100),
      size: clampNumber(src.weights.size, 5, 0, 100),
      codec: clampNumber(src.weights.codec, 5, 0, 100),
    };
  }

  out.maxResults = clampNumber(src.maxResults, 20, 1, 100);
  out.slowThreshold = clampNumber(src.slowThreshold, 4000, 1000, 60000);
  out.skipBadReleases = src.skipBadReleases !== false;
  out.priorityLang = ["", "pt-br", "en", "es", "fr"].includes(src.priorityLang) ? src.priorityLang : "pt-br";
  out.onlyDubbed = src.onlyDubbed === true;
  out.dedupe = src.dedupe !== false;
  out.keywordBoost = cleanString(src.keywordBoost, 500);
  const rawPriorityIndexers = Array.isArray(src.priorityIndexers)
    ? src.priorityIndexers
    : String(src.priorityIndexers || "").split(",").map(s => s.trim()).filter(Boolean);
  out.priorityIndexers = cleanStringArray(rawPriorityIndexers, 100, 120);
  out.maxResultsPerIndexer = clampNumber(src.maxResultsPerIndexer, 0, 0, 200);
  out.enableCatalog = src.enableCatalog !== false;
  const rawCatalogIds = Array.isArray(src.catalogIds)
    ? src.catalogIds
    : String(src.catalogIds || "").split(",").map(s => s.trim()).filter(Boolean);
  const catalogIds = cleanStringArray(rawCatalogIds, 100, 60);
  out.catalogIds = catalogIds.length ? catalogIds : ["all"];
  out.rssIndexers = cleanStringArray(src.rssIndexers, 100, 120);
  out.token = cleanString(src.token, 200);
  out.accessKey = cleanString(src.accessKey, 100);
  out.addonName = cleanString(src.addonName, 80);
  out.nameTemplate = cleanTemplate(src.nameTemplate, 300);
  out.descriptionTemplate = cleanTemplate(src.descriptionTemplate, 800);
  out.sortGroupBy = GROUP_KEYS.includes(src.sortGroupBy) ? src.sortGroupBy : DEFAULT_GROUP_BY;
  out.sortOrderBy = ORDER_KEYS.includes(src.sortOrderBy) ? src.sortOrderBy : DEFAULT_ORDER_BY;
  out.excludeFilters = cleanStringArray(src.excludeFilters, 20, 20).filter(k => EXCLUDE_FILTER_KEYS.includes(k));
  out.videoSizeLimit = cleanString(src.videoSizeLimit, 20);

  if (src.jackett && typeof src.jackett === "object" && !Array.isArray(src.jackett)) {
    const url = src.jackett.url ? safeServiceUrl(src.jackett.url) : "";
    if (url) out.jackett = { url, key: cleanString(src.jackett.key, 300) };
  }

  return out;
}

function normalizePrefs(u = {}) {
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  if (m.priorityLang === undefined) m.priorityLang = "pt-br";

  if (m.addonName) m.addonName = m.addonName.replace(/\s*\[(TB\+RD|TB|RD|QB|TS|PRO|ST)\]/gi, "").replace(/\bPRO\b/g, "").trim();
  if (!m.addonName) m.addonName = "TorrESMIN";

  m.sortGroupBy = GROUP_KEYS.includes(m.sortGroupBy) ? m.sortGroupBy : DEFAULT_GROUP_BY;
  m.sortOrderBy = ORDER_KEYS.includes(m.sortOrderBy) ? m.sortOrderBy : DEFAULT_ORDER_BY;
  m.sortBy = buildSortBy(m.sortGroupBy, m.sortOrderBy);

  m.excludeFilters = Array.isArray(m.excludeFilters) ? m.excludeFilters.filter(k => EXCLUDE_FILTER_KEYS.includes(k)) : [];
  m.videoSizeLimitBytes = parseSizeToBytes(m.videoSizeLimit);

  return m;
}

module.exports = {
  defaultPrefs,
  sanitizeUserPrefs,
  normalizePrefs,
  validateServiceUrl,
  safeServiceUrl,
  clampNumber,
  cleanString,
  cleanStringArray,
  cleanTemplate,
  GROUP_KEYS,
  ORDER_KEYS,
  DEFAULT_GROUP_BY,
  DEFAULT_ORDER_BY,
  parseSizeToBytes,
};
