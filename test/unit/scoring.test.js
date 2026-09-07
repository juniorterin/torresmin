"use strict";
require("../helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const scoring = require("../../scoring");

describe("score", () => {
  test("higher resolution and quality outrank lower ones", () => {
    const base = { Seeders: 10, Size: 8e9 };
    const s4k = scoring.score({ ...base, Title: "Movie.2020.2160p.BluRay.x265" });
    const s1080 = scoring.score({ ...base, Title: "Movie.2020.1080p.WEB-DL.x264" });
    const s480 = scoring.score({ ...base, Title: "Movie.2020.480p.HDRip.XviD" });
    assert.ok(s4k > s1080);
    assert.ok(s1080 > s480);
  });

  test("priority language beats generic multi/dual audio releases", () => {
    const title = base => `Movie.2020.1080p.WEB-DL.${base}`;
    const ptbr = scoring.score({ Title: title("Dublado.PT-BR"), Seeders: 5, Size: 8e9 }, {}, false, "pt-br");
    const multi = scoring.score({ Title: title("MULTI"), Seeders: 5, Size: 8e9 }, {}, false, "pt-br");
    const plain = scoring.score({ Title: title("x264"), Seeders: 5, Size: 8e9 }, {}, false, "pt-br");
    assert.ok(ptbr > multi);
    assert.ok(multi > plain);
  });

  test("more seeders increase the score, all else equal", () => {
    const t = "Movie.2020.1080p.WEB-DL.x264";
    const low = scoring.score({ Title: t, Seeders: 1, Size: 8e9 });
    const high = scoring.score({ Title: t, Seeders: 500, Size: 8e9 });
    assert.ok(high > low);
  });
});

describe("normalizeTitleTokens", () => {
  test("strips quality/resolution/year/episode markers and stopwords", () => {
    const tokens = scoring.normalizeTitleTokens("The.Matrix.1999.S01E02.1080p.BluRay.x264-GROUP");
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("1999"));
    assert.ok(!tokens.includes("1080p"));
    assert.ok(!tokens.includes("bluray"));
    assert.ok(tokens.includes("matrix"));
  });

  test("keeps short alphanumeric tokens like s1 but drops generic stopwords", () => {
    const tokens = scoring.normalizeTitleTokens("Se7en and the Movie");
    assert.ok(!tokens.includes("and"));
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("movie"));
  });
});

describe("titleMatchScore / relaxedTitleMatchScore / normalizedTokenOverlap", () => {
  test("exact alias match scores near 1", () => {
    const sc = scoring.titleMatchScore("The Shawshank Redemption 1994 1080p BluRay", ["The Shawshank Redemption"]);
    assert.ok(sc > 0.8, `expected high score, got ${sc}`);
  });

  test("unrelated title scores 0", () => {
    const sc = scoring.titleMatchScore("Completely Different Film 2020", ["The Shawshank Redemption"]);
    assert.equal(sc, 0);
  });

  test("single-letter word in the alias isn't dropped, so an unrelated title sharing only the generic word scores 0", () => {
    const sc = scoring.titleMatchScore("Diabolical The Epstein Files 2026 1080p WEBRip x265", ["The X-Files"]);
    assert.equal(sc, 0, `expected no match, got ${sc}`);
  });

  test("exact match still works when the alias has a meaningful single-letter word", () => {
    const sc = scoring.titleMatchScore("The X-Files S01E01 1080p BluRay", ["The X-Files"]);
    assert.ok(sc > 0.8, `expected high score, got ${sc}`);
  });

  test("relaxedTitleMatchScore gives partial credit for partial overlap", () => {
    const sc = scoring.relaxedTitleMatchScore("Shawshank Something Else 2020", ["The Shawshank Redemption"]);
    assert.ok(sc > 0 && sc < 1);
  });

  test("normalizedTokenOverlap measures alias coverage inside the title", () => {
    const full = scoring.normalizedTokenOverlap("The Matrix Reloaded 2003 1080p", ["Matrix Reloaded"]);
    const none = scoring.normalizedTokenOverlap("The Matrix Reloaded 2003 1080p", ["Totally Unrelated"]);
    assert.equal(full, 1);
    assert.equal(none, 0);
  });
});

describe("extractReleaseYear / normalizeImdbId / getResultImdbId", () => {
  test("extractReleaseYear finds a plausible year", () => {
    assert.equal(scoring.extractReleaseYear("Movie.1999.1080p"), 1999);
    assert.equal(scoring.extractReleaseYear("No year here"), null);
  });

  test("normalizeImdbId accepts tt-prefixed, bare numeric and mixed strings", () => {
    assert.equal(scoring.normalizeImdbId("tt1234567"), "tt1234567");
    assert.equal(scoring.normalizeImdbId("TT1234567"), "tt1234567");
    assert.equal(scoring.normalizeImdbId("1234567"), "tt1234567");
    assert.equal(scoring.normalizeImdbId("prefix-tt1234567-suffix"), "tt1234567");
    assert.equal(scoring.normalizeImdbId("not an id"), null);
    assert.equal(scoring.normalizeImdbId(""), null);
  });

  test("getResultImdbId reads across the common field name variants", () => {
    assert.equal(scoring.getResultImdbId({ ImdbId: "tt1111111" }), "tt1111111");
    assert.equal(scoring.getResultImdbId({ Imdb: "2222222" }), "tt2222222");
    assert.equal(scoring.getResultImdbId({ imdbId: "tt3333333" }), "tt3333333");
    assert.equal(scoring.getResultImdbId({}), null);
  });
});

describe("episode / pack detection", () => {
  test("looksLikeEpisodeRelease detects SxxExx and NxN markers", () => {
    assert.equal(scoring.looksLikeEpisodeRelease("Show.S01E02.1080p"), true);
    assert.equal(scoring.looksLikeEpisodeRelease("Show.1x02.1080p"), true);
    assert.equal(scoring.looksLikeEpisodeRelease("Movie.2020.1080p"), false);
  });

  test("isCompletePack detects season/series packs", () => {
    assert.equal(scoring.isCompletePack("Show.S01.Complete.1080p"), true);
    assert.equal(scoring.isCompletePack("Show S01 Season Pack 1080p"), true);
    assert.equal(scoring.isCompletePack("Show.S01E02.1080p"), false);
  });

  test("parseEpisodeRanges extracts SxxEyy-Ezz ranges for the requested season", () => {
    const ranges = scoring.parseEpisodeRanges("Show.S01E01-E05.1080p", 1);
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0], { season: 1, lo: 1, hi: 5 });
    assert.equal(scoring.parseEpisodeRanges("Show.S01E01-E05.1080p", 2).length, 0);
  });
});

describe("episodeMatchRank", () => {
  test("exact SxxExx match ranks highest (4)", () => {
    assert.equal(scoring.episodeMatchRank("Show.S01E02.1080p", 1, 2), 4);
  });
  test("episode inside a declared range ranks 3", () => {
    assert.equal(scoring.episodeMatchRank("Show.S01E01-E05.1080p", 1, 3), 3);
  });
  test("season-only release (no episode marker) ranks 2", () => {
    assert.equal(scoring.episodeMatchRank("Show.S01.1080p", 1, 3), 2);
  });
  test("a season-agnostic complete/batch pack ranks 1 for any requested episode", () => {
    assert.equal(scoring.episodeMatchRank("Show.Complete.Series.Batch", 1, 3), 1);
  });
  test("release naming a different episode ranks 0", () => {
    assert.equal(scoring.episodeMatchRank("Show.S01E09.1080p", 1, 3), 0);
  });
  test("no season/episode requested short-circuits to 1", () => {
    assert.equal(scoring.episodeMatchRank("Show.S01E09.1080p", null, null), 1);
  });
});

describe("animeEpisodeMatchRank", () => {
  test("matches [dash-episode] release naming", () => {
    assert.equal(scoring.animeEpisodeMatchRank("[Group] Anime - 05 [1080p]", 5), 3);
  });
  test("matches [bracketed episode] release naming", () => {
    assert.equal(scoring.animeEpisodeMatchRank("[Group] Anime [05] [1080p]", 5), 3);
  });
  test("range release covering the episode ranks 2", () => {
    assert.equal(scoring.animeEpisodeMatchRank("[Group] Anime 01-12 Batch", 5), 2);
  });
  test("unrelated episode number ranks 0", () => {
    assert.equal(scoring.animeEpisodeMatchRank("[Group] Anime - 12 [1080p]", 5), 0);
  });
});

describe("seriesEpisodeMatches / animeEpisodeMatches", () => {
  test("wrap the rank functions as booleans", () => {
    assert.equal(scoring.seriesEpisodeMatches("Show.S01E02.1080p", 1, 2), true);
    assert.equal(scoring.seriesEpisodeMatches("Show.S01E09.1080p", 1, 2), false);
    assert.equal(scoring.animeEpisodeMatches("[Group] Anime - 05 [1080p]", 5), true);
    assert.equal(scoring.animeEpisodeMatches("[Group] Anime - 12 [1080p]", 5), false);
  });
});

describe("dedupeResults", () => {
  test("collapses exact InfoHash duplicates", () => {
    const results = [
      { InfoHash: "ABC123", Title: "Movie 1080p", Seeders: 5 },
      { InfoHash: "abc123", Title: "Movie 1080p (mirror)", Seeders: 50 },
    ];
    const out = scoring.dedupeResults(results);
    assert.equal(out.length, 1);
  });

  test("collapses same normalized title + size, keeping the higher-seeder copy", () => {
    const results = [
      { Title: "Movie.2020.1080p.WEB-DL.x264-GRP", Seeders: 5, Size: 8e9 },
      { Title: "Movie 2020 1080p WEB-DL x264 GRP", Seeders: 80, Size: 8.01e9 },
    ];
    const out = scoring.dedupeResults(results);
    assert.equal(out.length, 1);
    assert.equal(out[0].Seeders, 80);
  });

  test("keeps genuinely different releases apart", () => {
    const results = [
      { Title: "Movie.2020.1080p.WEB-DL.x264-GRP", Seeders: 5, Size: 8e9 },
      { Title: "Another.Movie.2020.1080p.WEB-DL.x264-GRP", Seeders: 5, Size: 8e9 },
    ];
    assert.equal(scoring.dedupeResults(results).length, 2);
  });
});

describe("dedupeWithCachePriority", () => {
  // Mesmo título normalizado (mesmo release) e mesma faixa de tamanho — só assim
  // dedupeWithCachePriority os trata como o mesmo grupo e aplica o desempate.
  function group() {
    const TITLE = "Movie.2020.1080p.WEB-DL.x264-GRP";
    return [
      { Title: TITLE, Seeders: 10, Size: 8e9, _resolved: { infoHash: "hash1" }, _isCached: false, MagnetUri: "magnet:?xt=urn:btih:" + "1".repeat(40) },
      { Title: TITLE, Seeders: 3,  Size: 8e9, _resolved: { infoHash: "hash2" }, _isCached: true,  MagnetUri: "magnet:?xt=urn:btih:" + "2".repeat(40) },
    ];
  }

  test("non-debrid mode keeps the higher-seeder release per group", () => {
    const out = scoring.dedupeWithCachePriority(group(), false);
    assert.equal(out.length, 1);
    assert.equal(out[0].Seeders, 10);
  });

  test("debrid mode prefers a cached-public release over an uncached one, even with fewer seeders", () => {
    const out = scoring.dedupeWithCachePriority(group(), true);
    assert.equal(out.length, 1);
    assert.equal(out[0]._isCached, true);
  });

  test("debrid mode always prefers a priority-indexer release", () => {
    const items = group();
    items[1]._priorityIndexer = true;
    const out = scoring.dedupeWithCachePriority(items, true);
    assert.equal(out[0]._priorityIndexer, true);
  });
});

describe("stream formatting helpers", () => {
  test("extractGroup pulls the release group from the tail of the title", () => {
    assert.equal(scoring.extractGroup("Movie.2020.1080p.WEB-DL.x264-GROUP"), "GROUP");
    assert.equal(scoring.extractGroup("Movie 2020 1080p WEB-DL x264"), null);
  });

  test("fmtBytes renders GB for large sizes and MB for small ones", () => {
    assert.equal(scoring.fmtBytes(8_000_000_000), "8.00 GB");
    assert.equal(scoring.fmtBytes(500_000_000), "500 MB");
    assert.equal(scoring.fmtBytes(0), null);
  });

  test("stripSourceBadges removes the [TORRENT]/[P2P] markers", () => {
    assert.equal(scoring.stripSourceBadges("[TORRENT 🧲] Movie 1080p"), "Movie 1080p");
    assert.equal(scoring.stripSourceBadges("[P2P] Movie 1080p"), "Movie 1080p");
  });

  test("visibleSeedCount falls back through _displaySeeds, Seeders, _seeders", () => {
    assert.equal(scoring.visibleSeedCount({ _displaySeeds: 7, Seeders: 1 }), 7);
    assert.equal(scoring.visibleSeedCount({ Seeders: 42 }), 42);
    assert.equal(scoring.visibleSeedCount({ _seeders: 3 }), 3);
    assert.equal(scoring.visibleSeedCount({}), 0);
  });
});

describe("matchesKeywordBoost", () => {
  test("matches a simple case-insensitive regex", () => {
    assert.equal(scoring.matchesKeywordBoost("Movie.REMUX.2020", "remux"), true);
    assert.equal(scoring.matchesKeywordBoost("Movie.WEB-DL.2020", "remux"), false);
  });

  test("rejects empty patterns and blocks ReDoS-suspicious ones", () => {
    assert.equal(scoring.matchesKeywordBoost("Movie.2020", ""), false);
    assert.equal(scoring.matchesKeywordBoost("a".repeat(40) + "!", "(a+)+"), false);
  });

  test("swallows invalid regex patterns instead of throwing", () => {
    assert.equal(scoring.matchesKeywordBoost("Movie.2020", "(unclosed"), false);
  });
});

describe("splitFilterTerms / textHasAnyTerm", () => {
  test("splits on comma/semicolon/pipe/newline and lowercases", () => {
    assert.deepEqual(scoring.splitFilterTerms("A, b; C|d\ne"), ["a", "b", "c", "d", "e"]);
  });

  test("numeric terms require a word boundary, text terms use substring match", () => {
    assert.equal(scoring.textHasAnyTerm("season 1080p pack", ["1080"]), false);
    assert.equal(scoring.textHasAnyTerm("season 1080 pack", ["1080"]), true);
    assert.equal(scoring.textHasAnyTerm("Movie REMUX Edition", ["remux"]), true);
  });
});

describe("priority/exclusion filters", () => {
  test("isPriorityIndexerResult matches against the indexer name text", () => {
    const prefs = { priorityIndexers: ["CapybaraBR"] };
    assert.equal(scoring.isPriorityIndexerResult({ _indexerName: "CapybaraBR" }, prefs), true);
    assert.equal(scoring.isPriorityIndexerResult({ _indexerName: "OtherTracker" }, prefs), false);
  });

  test("isRdExcludedResult matches keywords, qualities, indexers and release groups", () => {
    const prefs = { rdExcludeKeywords: "dublado", rdExcludeGroups: "GRP" };
    assert.equal(scoring.isRdExcludedResult({ Title: "Movie Dublado 1080p" }, prefs), true);
    assert.equal(scoring.isRdExcludedResult({ Title: "Movie.2020.1080p-GRP" }, prefs), true);
    assert.equal(scoring.isRdExcludedResult({ Title: "Movie.2020.1080p-OTHER" }, prefs), false);
  });
});

describe("isExcludedByFilters (checkboxes estilo Torrentio)", () => {
  test("matches BluRay REMUX, resolution buckets and Cam/Screener", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.BluRay.REMUX", ["brremux"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.1080p.WEB-DL", ["brremux"]), false);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.1080p.WEB-DL", ["1080p"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.720p.WEB-DL", ["1080p"]), false);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.CAMRip.XviD", ["cam"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.SCREENER.XviD", ["screener"]), true);
  });

  test("dvhdr only matches when both Dolby Vision and HDR are present together", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.DV.HDR.BluRay", ["dvhdr"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.DV.BluRay", ["dvhdr"]), false);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.HDR.BluRay", ["dvhdr"]), false);
  });

  test("hdrany matches any of HDR/HDR10+/Dolby Vision, unlike the narrower dolbyvision filter", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.HDR10+.BluRay", ["hdrany"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.HDR10+.BluRay", ["dolbyvision"]), false);
  });

  test("unknown matches only when no resolution tag is detected at all", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.XviD-GROUP", ["unknown"]), true);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.720p.XviD-GROUP", ["unknown"]), false);
  });

  test("returns false when no exclude keys are selected", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.CAMRip.XviD", []), false);
    assert.equal(scoring.isExcludedByFilters("Movie.2020.CAMRip.XviD", undefined), false);
  });

  test("an unknown filter key never matches", () => {
    assert.equal(scoring.isExcludedByFilters("Movie.2020.2160p.BluRay.REMUX", ["bogus"]), false);
  });
});

describe("hasDirectInfoHash", () => {
  test("true for a direct InfoHash or a magnet carrying a btih hash", () => {
    assert.equal(scoring.hasDirectInfoHash({ InfoHash: "abc" }), true);
    assert.equal(scoring.hasDirectInfoHash({ MagnetUri: "magnet:?xt=urn:btih:" + "a".repeat(40) }), true);
    assert.equal(scoring.hasDirectInfoHash({ Link: "https://example.com/x.torrent" }), false);
  });
});

describe("renderTemplate", () => {
  test("substitutes {token} placeholders", () => {
    const out = scoring.renderTemplate("{addon} {resolution}", { addon: "TS", resolution: "1080p" });
    assert.equal(out, "TS 1080p");
  });

  test("drops a whole line when every token it references is empty", () => {
    const out = scoring.renderTemplate("{title}\n💾 {size}\n🌱 {seeders}", { title: "Movie", size: "", seeders: "" });
    assert.equal(out, "Movie");
  });
});

describe("formatStream", () => {
  test("maps resolution to a friendly label and includes size/seeders in the description", () => {
    const r = { Title: "Movie.2020.1080p.WEB-DL.DTS.x264-GRP", Seeders: 12, Size: 8e9 };
    const { name, description, resLabel } = scoring.formatStream(r, "SomeIndexer", false, {}, true, { title: "Movie", year: 2020 });
    assert.equal(resLabel, "🔵 FHD");
    assert.match(name, /FHD/);
    assert.match(description, /Movie \(2020\)/);
    assert.match(description, /🌱 12/);
  });

  test("honors a custom nameTemplate over the default name", () => {
    const r = { Title: "Movie.2020.1080p.WEB-DL.x264-GRP", Seeders: 12, Size: 8e9 };
    const prefs = { nameTemplate: "{addon} | {resolution}", addonName: "MyAddon" };
    const { name } = scoring.formatStream(r, "SomeIndexer", false, prefs, true, {});
    assert.equal(name, "MyAddon | 🔵 FHD");
  });
});
