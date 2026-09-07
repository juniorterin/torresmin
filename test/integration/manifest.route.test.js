"use strict";
require("../helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startRouterApp } = require("../helpers/testApp");
const manifestRouter = require("../../routes/manifest");

describe("GET /manifest.json", () => {
  test("returns the base, unconfigured manifest", async (t) => {
    const app = await startRouterApp(manifestRouter);
    t.after(() => app.close());

    const res = await fetch(`${app.baseUrl}/manifest.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "org.torresmin.app");
    assert.deepEqual(body.catalogs, []);
    assert.equal(body.behaviorHints.configurationRequired, true);
    assert.match(body.logo, /\/logo-pixel-static\.png$/);
  });
});

describe("GET /:userConfig/manifest.json", () => {
  test("falls back to defaults for an unknown/garbage config id", async (t) => {
    const app = await startRouterApp(manifestRouter);
    t.after(() => app.close());

    const res = await fetch(`${app.baseUrl}/cfg_${"a".repeat(24)}/manifest.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "TorrESMIN");
    assert.ok(body.types.includes("movie"));
    assert.ok(body.types.includes("series"));
    assert.equal(body.behaviorHints.configurationRequired, false);
  });

  test("respects a directly base64url-encoded config (name and categories)", async (t) => {
    const app = await startRouterApp(manifestRouter);
    t.after(() => app.close());

    const cfg = Buffer.from(JSON.stringify({ addonName: "Minha Instância", categories: ["movie"] }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const res = await fetch(`${app.baseUrl}/${cfg}/manifest.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "Minha Instância");
    assert.deepEqual(body.types, ["movie"]);
  });
});
