"use strict";
require("../helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Validação estrutural dos catálogos semente. Não toca a rede — a conferência
// de que cada id aponta para o filme certo é do scripts/verifyCatalogs.js, que
// consulta o IMDb e leva ~25min. Aqui é o que dá pra garantir em segundos, a
// cada push.
//
// Existe porque metade dos ids já esteve errada uma vez: o commit 28d6f77
// adicionou 54 catálogos gerados em massa, e um passe de correção posterior
// (a36570e) reapontou "Midnight" (1939) para um filme de 1989. Nada no CI
// impedia nem um nem outro.

const SEED_DIR = path.join(__dirname, "..", "..", "scripts", "seed-data");
const SEED_SCRIPT = path.join(__dirname, "..", "..", "scripts", "seedCatalogs.js");

function seedFiles() {
  return fs.readdirSync(SEED_DIR).filter(f => f.endsWith(".json"));
}
function readSeed(file) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
}

describe("scripts/seed-data", () => {
  test("todo arquivo é um array não vazio", () => {
    for (const file of seedFiles()) {
      const entries = readSeed(file);
      assert.ok(Array.isArray(entries), `${file} não é um array`);
      assert.ok(entries.length > 0, `${file} está vazio`);
    }
  });

  test("todo imdbId tem o formato tt seguido de 7 a 8 dígitos", () => {
    const ruins = [];
    for (const file of seedFiles()) {
      for (const e of readSeed(file)) {
        if (!/^tt\d{7,8}$/.test(e.imdbId || "")) ruins.push(`${file}: ${JSON.stringify(e.imdbId)} (${e.title})`);
      }
    }
    assert.deepEqual(ruins, [], `ids malformados:\n  ${ruins.join("\n  ")}`);
  });

  test("toda entrada tem título e ano plausível", () => {
    const ruins = [];
    const anoAtual = new Date().getFullYear();
    for (const file of seedFiles()) {
      for (const e of readSeed(file)) {
        if (!e.title || typeof e.title !== "string") ruins.push(`${file}: entrada sem título (${e.imdbId})`);
        const ano = Number(e.year);
        // 1888 é o Roundhay Garden Scene, o filme mais antigo que se conhece.
        if (!Number.isInteger(ano) || ano < 1888 || ano > anoAtual + 2) {
          ruins.push(`${file}: ano improvável ${JSON.stringify(e.year)} em "${e.title}"`);
        }
      }
    }
    assert.deepEqual(ruins, [], `entradas inválidas:\n  ${ruins.join("\n  ")}`);
  });

  test("nenhum catálogo repete o mesmo imdbId", () => {
    const ruins = [];
    for (const file of seedFiles()) {
      const vistos = new Set();
      for (const e of readSeed(file)) {
        if (vistos.has(e.imdbId)) ruins.push(`${file}: ${e.imdbId} aparece mais de uma vez`);
        vistos.add(e.imdbId);
      }
    }
    assert.deepEqual(ruins, [], `duplicatas:\n  ${ruins.join("\n  ")}`);
  });

  test("CATALOGS e os arquivos batem nos dois sentidos", () => {
    // Slug declarado sem arquivo faz o seed pular em silêncio; arquivo sem slug
    // nunca vira catálogo. Os dois já aconteceram neste repositório.
    const src = fs.readFileSync(SEED_SCRIPT, "utf8");
    const slugs = [...src.matchAll(/slug:\s*"([^"]+)"/g)].map(m => m[1]);
    const arquivos = seedFiles().map(f => path.basename(f, ".json"));

    const semArquivo = slugs.filter(s => !arquivos.includes(s));
    const semSlug = arquivos.filter(f => !slugs.includes(f));

    assert.deepEqual(semArquivo, [], `slugs em CATALOGS sem arquivo: ${semArquivo.join(", ")}`);
    assert.deepEqual(semSlug, [], `arquivos sem entrada em CATALOGS: ${semSlug.join(", ")}`);
  });

  test("nenhum slug é declarado duas vezes em CATALOGS", () => {
    const src = fs.readFileSync(SEED_SCRIPT, "utf8");
    const slugs = [...src.matchAll(/slug:\s*"([^"]+)"/g)].map(m => m[1]);
    const repetidos = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    assert.deepEqual(repetidos, [], `slugs repetidos: ${repetidos.join(", ")}`);
  });
});
