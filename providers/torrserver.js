/**
 * providers/torrserver.js
 *
 * Backend de streaming via TorrServer (github.com/YouROK/TorrServer).
 * Ao contrário do qBittorrent, o TorrServer prioriza peças dinamicamente
 * com base na posição de leitura de cada player conectado — suporta seek
 * de verdade em qualquer ponto do arquivo, mesmo ainda baixando.
 *
 * O TorrServer nunca fica exposto na internet nem fala diretamente com o
 * player: todo pedido de vídeo passa por proxyStream() aqui embaixo, que
 * reencaminha os bytes através deste app. Isso é o que garante que só quem
 * tem uma chave de acesso válida (accessKeys.js, checada em routes/play.js
 * antes de chamar qualquer coisa neste módulo) consegue de fato assistir —
 * sem essa camada, qualquer pessoa que descobrisse o endereço do TorrServer
 * poderia adicionar magnets e assistir livremente, sem passar pelo addon.
 */

const { Readable } = require("stream");

const TS_URL  = (process.env.TS_URL  || "").replace(/\/+$/, "");
const TS_USER = process.env.TS_USER || "";
const TS_PASS = process.env.TS_PASS || "";

function isConfigured() {
  return !!TS_URL;
}

function authHeader() {
  if (!TS_USER && !TS_PASS) return {};
  const token = Buffer.from(`${TS_USER}:${TS_PASS}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function tsApi(path, options = {}) {
  const url = `${TS_URL}${path}`;
  const headers = { ...authHeader(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  return res;
}

// Torrents públicos: magnet puro basta (DHT/PEX resolve peers e metadata).
// Torrents privados: o tracker exige o .torrent original (passkey/announce),
// magnet puro não participa de DHT/PEX nesses casos.
async function addByMagnet(magnet) {
  const res = await tsApi("/torrents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", link: magnet, save_to_db: false }),
  });
  if (!res.ok) throw new Error(`TorrServer add (magnet) falhou: ${res.status}`);
  return res.json();
}

async function addByTorrentBuffer(torrentBuffer) {
  const form = new FormData();
  form.append("save", "false");
  form.append("file", new Blob([torrentBuffer], { type: "application/x-bittorrent" }), "torrent.torrent");
  const res = await tsApi("/torrent/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`TorrServer add (.torrent) falhou: ${res.status}`);
  const list = await res.json();
  const entry = Array.isArray(list) ? list[0] : list;
  if (!entry?.hash) throw new Error("TorrServer não retornou hash ao enviar .torrent");
  return entry;
}

async function getTorrentInfo(hash) {
  const res = await tsApi("/torrents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get", hash }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function waitForFileStats(hash, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getTorrentInfo(hash);
    if (info?.file_stats?.length) return info;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function pickTargetFile(fileStats, fileIdx, fileName) {
  if (!Array.isArray(fileStats) || !fileStats.length) return null;
  if (Number.isInteger(fileIdx)) {
    const byId = fileStats.find(f => f.id === fileIdx);
    if (byId) return byId;
  }
  if (fileName) {
    const normalized = String(fileName).replace(/^\/+/, "");
    const byName = fileStats.find(f =>
      String(f.path || "") === normalized || String(f.path || "").endsWith(`/${normalized}`)
    );
    if (byName) return byName;
  }
  const videoFiles = fileStats.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.path || ""));
  const pool = videoFiles.length ? videoFiles : fileStats;
  return pool.reduce((best, current) => ((current.length || 0) > (best.length || 0) ? current : best));
}

/**
 * Garante que o torrent está adicionado ao TorrServer e resolve qual arquivo
 * (hash + fileId) o player deve receber. Não retorna uma URL — o chamador
 * usa proxyStream() para efetivamente servir o vídeo.
 */
async function resolvePlayTarget({ magnet, torrentBuffer, fileIdx = null, fileName = null }) {
  let entry;
  if (torrentBuffer) {
    entry = await addByTorrentBuffer(torrentBuffer);
  } else if (magnet) {
    entry = await addByMagnet(magnet);
  } else {
    throw new Error("Nenhuma fonte disponível para adicionar ao TorrServer (magnet ou .torrent)");
  }

  const hash = entry.hash;
  if (!hash) throw new Error("TorrServer não retornou hash do torrent");

  const info = await waitForFileStats(hash);
  if (!info) throw new Error("TorrServer não retornou metadados do torrent a tempo");

  const target = pickTargetFile(info.file_stats, fileIdx, fileName);
  if (!target) throw new Error("Nenhum arquivo de vídeo encontrado no torrent");

  return { hash, fileId: target.id };
}

const FORWARD_REQUEST_HEADERS = ["range", "if-range"];
const FORWARD_RESPONSE_HEADERS = [
  "content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control",
];

/**
 * Reencaminha o pedido do player pro endpoint /play/:hash/:fileId do
 * TorrServer e devolve a resposta (status, headers relevantes e corpo) sem
 * nunca redirecionar o player pro endereço real do TorrServer.
 */
async function proxyStream(req, res, hash, fileId) {
  const headers = { ...authHeader() };
  for (const h of FORWARD_REQUEST_HEADERS) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${TS_URL}/play/${hash}/${fileId}`, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    throw err;
  }

  res.status(upstream.status);
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(h);
    if (value) res.setHeader(h, value);
  }

  if (req.method === "HEAD" || !upstream.body) return res.end();

  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (err) => {
    if (!controller.signal.aborted) {
      console.error("[torrserver] erro ao repassar stream:", err.message);
    }
    if (!res.headersSent) res.sendStatus(502);
    res.destroy();
  });
  res.on("error", () => stream.destroy());
  stream.pipe(res);
}

module.exports = {
  isConfigured,
  resolvePlayTarget,
  proxyStream,
  getTorrentInfo,
};
