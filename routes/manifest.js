const express = require("express");
const { resolvePrefs } = require("../configStore");
const { getPublicBase } = require("../routeHelpers");
const { listCatalogs } = require("../catalogs");

const router = express.Router();

router.get("/manifest.json", (req, res) => {
  res.json({
    id: "org.torresmin.app", version: "1.0.0", name: "TorrESMIN",
    logo: `${getPublicBase(req)}/logo-pixel-static.png`,
    icon: `${getPublicBase(req)}/logo-pixel-static.png`,
    description: "Prowlarr/Jackett + TorrServer, com filtros por keywords",
    resources: ["stream", "meta"], types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "rssitem:"],
    catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  });
});

router.get("/:userConfig/manifest.json", async (req, res) => {
  const prefs  = await resolvePrefs(req.params.userConfig);

  const types  = [...new Set((prefs.categories || ["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name   = prefs.addonName || "TorrESMIN";

  const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length ? prefs.categories : ["movie", "series"];
  const catalogs = [];
  if (prefs.enableCatalog) {
    const curated = await listCatalogs();
    const wantsAll = !Array.isArray(prefs.catalogIds) || prefs.catalogIds.includes("all");
    for (const cat of curated) {
      if (!enabledCats.includes(cat.type)) continue;
      if (!wantsAll && !prefs.catalogIds.includes(cat.id)) continue;
      catalogs.push({ type: cat.type, id: `curated_${cat.id}`, name: cat.name, extra: [{ name: "skip", isRequired: false }] });
    }
  }

  res.json({
    id: "org.torresmin.app", version: "1.0.0", name,
    logo: `${getPublicBase(req)}/logo-pixel-static.png`,
    icon: `${getPublicBase(req)}/logo-pixel-static.png`,
    description: "Prowlarr/Jackett + TorrServer, com filtros por keywords",
    resources: [
      "catalog",
      { name: "meta",   types, idPrefixes: ["rssmovie:", "rssmeta:", "rssitem:"] },
      { name: "stream", types },
    ],
    types, idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "rssitem:"], catalogs,
    behaviorHints: { configurable: true, configurationRequired: false, p2p: true },
  });
});

module.exports = router;
