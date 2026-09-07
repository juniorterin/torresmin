# RSS catalog vs. curated catalogs

**Question:** there are two things called "catalog" in this codebase with overlapping-looking id schemes (`rssmovie:`, `rssmeta:`, `curated_...`) — are they the same feature?

**Answer: no, two separate features that happen to both feed the Stremio home screen's catalog rows.**

## RSS catalog — "recently added," fully automatic

`rssPoller.js` runs on a timer (`RSS_UPDATE_INTERVAL_MINUTES`, default 30) and re-polls each configured indexer's RSS feed, caching the raw parsed results per indexer/type in `rc` (see `.claude/docs/persistence.md`'s sibling doc on `cache.js` if you're looking for it — it's covered inline in `.claude/docs/stream-pipeline.md` instead, since it's the same `rc` used there). `rssHelpers.js` is the read side: it turns that cache into actual Stremio catalog metas and per-title "videos" (episode lists), using three id schemes depending on what's being described — `rssmovie:<imdbId>` for a movie, `rssmeta:<type>:<imdbId>` for a series/anime's meta entry, `rssitem:<type>:<metaId>:<season>:<episode>[:<token>]` for one specific episode's stream. This whole feature requires no admin curation at all — it's a live reflection of what your indexers' RSS feeds currently list, filtered by `RSS_CATALOG_INDEXERS` if set.

## Curated catalogs — hand-picked lists, admin-managed

`catalogs.js` (see `.claude/docs/persistence.md` — it's one of the three modules using the dual Postgres/file backend pattern). An admin creates a named catalog (e.g. "Criterion Collection"), of a fixed `type` (`movie`/`series`), and adds specific IMDb ids to it one at a time (`routes/adminApi.js`'s `/admin/api/catalogs/*` routes, gated by `ADMIN_PASSWORD` — see `.claude/docs/auth.md`). These ship pre-seeded from `scripts/seed-data/*.json` (Criterion, IMDb Top 250, Sight & Sound, TSPDT 100, "mindbending") via `scripts/seedCatalogs.js`, run manually, not automatically. `routes/manifest.js` exposes each enabled one as `curated_<id>` in the manifest's `catalogs` array (only for the categories the user's prefs include); `routes/catalog.js` serves its actual contents, fetching each IMDb id's metadata from Cinemeta and caching the assembled catalog for 6 hours (`CATALOG_CACHE_TTL`) — busted immediately (`bustCache`, an `rc.del`) whenever an admin edits that catalog, so an edit doesn't sit invisible for up to 6 hours.

## The shared piece: `metadata.js`

Both features can end up calling `metadata.enrichMetaPtBr(meta, imdbId, type)` — it augments whatever Cinemeta metadata was fetched with TMDB's pt-BR title/poster/backdrop/overview/rating/genres, but only if `TMDB_API_KEY` or `TMDB_BEARER_TOKEN` is set (`hasTmdbAuth()`); otherwise every call is a silent no-op returning the input unchanged. There's a small in-process `Map` cache (`tmdbCache`) keyed by `type:imdbId` inside `metadata.js` itself, separate from `rc` — it's not shared across processes and doesn't expire, which is fine for TMDB metadata (doesn't change often) but worth knowing if you're trying to reason about staleness here specifically.

## How a curated catalog actually gets built, end to end

There are two ways to create one, and they converge on the same storage:

1. **Through `/admin`** — `createCatalog(id, name, type)` then `addCatalogItem(id, imdbId)` one title at a time (`routes/adminApi.js`). Fine for a handful of titles or ongoing edits.
2. **Through the seed script** — the bulk-import path, and the one that matters for standing up a new list from an external source:
   - Add a `scripts/seed-data/<slug>.json` file: a flat array of `{ "title": ..., "year": ..., "imdbId": "tt..." }`.
   - Add a matching entry to the `CATALOGS` array at the top of `scripts/seedCatalogs.js` (`{ slug, name, type }`).
   - Run `node scripts/seedCatalogs.js` (needs the same env as the app — `CONFIG_DATA_DIR` or `CONFIG_DATABASE_URL` — so it writes to the same store the running app reads from). It's idempotent: re-running it never duplicates the catalog or an item already in it, so it's safe to re-run after adding more rows to the JSON file later.
   - **The `imdbId` for every row must already be resolved before it goes in the file.** Cinemeta only exposes `/meta/<type>/<imdbId>.json` — there's no title-search endpoint it or this codebase can call — so turning a list of titles (from Sight & Sound, TSPDT, Letterboxd, wherever) into `{title, year, imdbId}` rows is a manual/external research step, not something `seedCatalogs.js` does for you.

There are 67 seed files today, ~4850 entries total, all wired into `CATALOGS`. Every one follows the same two-step recipe — a seed-data JSON plus a `CATALOGS` entry — there's no per-source special-casing in the code.

## Data integrity: most of these IDs were fabricated, and how that was fixed

**Question:** the seed files look like plain research output. Why does this codebase carry a verification script, and why does its doc keep insisting the IDs be checked?

**Answer: because roughly half of them were wrong, and the failure was invisible.** A wrong `imdbId` here is not a broken link — it's a *valid ID of a different film*. The catalog loads normally and shows the wrong movie. Nothing errors, nothing logs.

### Where the bad data came from

Git history separates the good from the bad cleanly:

- Catalogs seeded from **lists that exist publicly** — `imdbtop250`, `sightsound`, `tspdt100`, `afi_*`, `criterion`, most `director_*` — came from commits like `3724e01` ("Seed the 5 curated catalogs with real data") and audited at ~0 errors.
- Catalogs from commit **`28d6f77`** ("expandir catálogos seed — 54 novos catálogos") — 54 catalogs, 2056 lines, one commit — audited at **~46% wrong**. Nobody researches thousands of IMDb IDs in one sitting; that content was bulk-generated.

The error signature confirms it: the bad IDs are *well-formed and in the right numeric range for the era* (`tt0048544` for a 1955 film is plausible) but point elsewhere. That is what generating IDs from memory produces — format right, target wrong.

It maps onto category, too. Nouvelle Vague, Cinema Novo, Neorealism, cinema-by-country, "road movies" are **editorial** lists that exist nowhere ready-made, so both the list and the IDs were invented. Criterion and IMDb Top 250 had a real source to copy, and survived.

A later repair attempt, `a36570e` ("corrigir IMDb IDs via verificação TMDB"), introduced errors of its own — it repointed *Midnight* (1939) at a 1989 film.

### The verification script

```bash
node scripts/verifyCatalogs.js                # everything (~25 min)
node scripts/verifyCatalogs.js world_brazil   # one or more catalogs
node scripts/verifyCatalogs.js --fresh        # ignore the local cache
```

It asks one question per row: does this `imdbId` really point at that title, in that year? Output goes to `scripts/catalog-report.json` (gitignored), split into `broken` / `yearOff` / `notFeature` / `translated` / `unchecked`.

**Why IMDb and not Cinemeta.** The script queries `https://v2.sg.media-imdb.com/suggestion/t/<imdbId>.json` — the endpoint behind imdb.com's own autocomplete. No key, and it returns title (`l`), year (`y`) and type (`q`: feature/short/TV series). Cinemeta is worse for *validation* on both counts: it has no type field, and `/meta/movie/<id>` answers with **a different film's data** rather than a 404 when the ID belongs to a series — `tt0080196` comes back as "Million Dollar Mermaid" instead of Berlin Alexanderplatz. Cinemeta remains the right source at runtime (`routes/catalog.js`); it is the wrong source for auditing.

### Two traps, both learned the hard way

**A nonexistent ID does not error — it returns the closest match.** Querying `tt9999999999` answers "Space: 1999". Any checker that accepts the first result will mark every broken ID as valid. The script only accepts a result whose `id` is *identical* to the one queried.

**A failed lookup is not a finding.** The first run used concurrency 6, collected `429 Too Many Requests` partway through ~4855 lookups, treated each failure as "ID doesn't exist", *and cached that*. The report claimed **2703 broken IDs** — including catalogs already known to be clean. The rerun, sequential with 300ms spacing, found **1**. So: the lookup has three states (verified / confirmed-missing / could-not-check), failures never reach the cache, and `unchecked` is reported separately with an explicit note that it is not a defect.

### The limitation that remains

The check reprove a row only when title **and** year both diverge. When a wrong ID happens to point at a film of the *same year*, it lands in the `translated` bucket alongside legitimate cases like Tilai→"The Law" and Uzak→"Distant".

Six real defects were hiding there and came out only by reading the bucket by hand (*She Danced One Summer* → "Son of Paleface", *Mon oncle d'Amérique* → "Private Benjamin", …). **~100 entries in that bucket have never been reviewed one by one.**

Year alone cannot separate "translated title" from "wrong film, same year". The natural tiebreaker is director, and the IMDb suggestion endpoint returns cast (`s`), not director — so closing this gap needs a second source (TMDB has director and this repo already has optional TMDB support in `metadata.js`) or manual review.

### Seed files are not the live catalog

This trips people up constantly: **fixing a seed file changes nothing in production.** `scripts/seed-data/*.json` is input to `seedCatalogs.js`; what the app serves is the store (`torresmin_catalogs.json`, or Postgres). They drift apart, and have: the store has carried ~5850 items while the seed files were down to ~4850 after corrections.

Worse, `seedCatalogs.js` is **additive** — it is idempotent about not duplicating, but it does not delete. Entries removed from a seed file stay in the store forever. Applying removals needs either a store edit through `/admin` or a deliberate reseed strategy.

Symptom to recognize: a catalog shows fewer items than its seed file has. Those missing rows are stale bad IDs in the store that Cinemeta cannot resolve, so `routes/catalog.js` drops them.

## Serving a catalog: why `routes/catalog.js` looks defensive

**Question:** why is the metadata fetch there rate-limited and split across two caches, when a plain `Promise.all` would be shorter?

**Answer: because the plain version took the whole home screen down, and did it silently.** The original built each catalog with `Promise.all(catalog.items.map(...))` — no bound. A 103-film catalog opened 103 simultaneous Cinemeta connections. Stremio requests *many* catalogs at once when the home screen opens, and with 69 rows in the manifest the peak went past a thousand parallel requests.

Cinemeta timed out, every item hit `catch { return null }`, the catalog was assembled nearly empty — **and the empty result was cached for 6 hours.** Measured live: 45 of 69 catalogs cached completely empty, 10 more under 25 items, 14 healthy. The user-visible symptom was "catalogs load up to about the 30th, the rest spin and vanish", and they stayed broken because the poison had a 6-hour TTL.

Three things keep it from coming back, and none should be removed casually:

- **`META_CONCURRENCY = 8`** per catalog instead of unbounded.
- **Per-ID metadata cache** (`cinemeta:<type>:<id>`, 7 days). The same film appears across many catalogs, so the second catalog containing it costs nothing. This is what took a large cold catalog from 19.6s to ~4.5s.
- **`CATALOG_MIN_SUCCESS_RATIO`** — a build resolving under 80% of its items is cached for 2 minutes, not 6 hours, and logs a warning. A bad moment at Cinemeta must not own the rest of the day.

If catalogs go empty again, check the cache before the data: `keys curatedcatalog:*` in Redis and count how many hold `[]`. Note that `cache.js` falls back to an in-memory Map, so clearing that cache from a *separate* `node -e` process silently does nothing to the running server — go through Redis directly.

## Content roadmap: what other curated catalogs could exist

Ideas gathered for where to go next, organized by what kind of "curation" each one represents — useful for deciding what a catalog's `name` and framing should communicate, since the source *is* the pitch to the user (why these specific movies are grouped together). All still `type: "movie"` unless noted; nothing below is seeded yet.

- **Institutional collections** (a body of experts stands behind the whole list): Criterion Collection (already seeded — could be split further into `Criterion — Japão`, `Criterion — Horror`, `Criterion — Noir`, `Criterion — Documentários`, `Criterion 4K`, each just a differently-filtered subset of the same source), MoMA, BFI, Cinémathèque Française, Harvard Film Archive, UCLA Film & Television Archive, Academy Film Archive, and the **National Film Registry** (US Library of Congress preservation list — historical/preservation curation, not a quality ranking, which is itself a distinct enough angle to be worth calling out in the name).
- **Critical/canon rankings** (a poll or aggregate, not one person's taste): **Sight & Sound** (already seeded as Top 100 — the source actually supports `Top 250`, a separate `Directors' Poll`, and is published once a decade so a `1952 → 2022` historical-editions angle is possible too), **TSPDT** (already seeded at 100 — the source goes to 1,000 and 2,500 entries, and also publishes by-decade and by-country breakdowns and a directors ranking), **AFI** (100 Years...100 Movies, plus themed lists: Thrills, Laughs, Passions, Heroes & Villains), **Cahiers du Cinéma** (best-of-year and Nouvelle Vague-adjacent lists — more explicitly auteurist/French in framing than the others).
- **Popular ranking**: **IMDb Top 250** (already seeded — could add Top 100/Top 50 cuts, or by-decade). Worth explicitly framing as "popular" vs. the critical lists above if both are ever shown side by side (e.g. `👥 Popular — IMDb Top 250` next to `🎓 Críticos — Sight & Sound`) — the whole point of offering both is that they're curated by different audiences and will disagree.
- **Festivals**: Cannes (Palme d'Or, Grand Prix, Jury Prize — could each be its own catalog, or one festival catalog per prize), Berlinale (Golden/Silver Bear), Venice (Golden/Silver Lion). Same shape as everything else — a list of winning titles, resolved to IMDb ids.
- **Genre deep-dives** — more specific than a blanket "Horror" catalog: Giallo, Vampire Cinema, Zombie Cinema, Slasher, Folk Horror, Haunted House, Psychological Horror, Body Horror, Cosmic Horror, and by-country variants (Italian Horror, Japanese Horror, Korean Horror). The pattern generalizes past horror — any genre benefits from being split into recognizable subgenres rather than one dumping-ground list.
- **Film movements** (cinema by era + shared aesthetic, not just by country): Nouvelle Vague, Italian Neorealism, German Expressionism, Cinema Novo, Japanese New Wave, Hong Kong New Wave, Iranian New Wave, Czech New Wave, Romanian New Wave, New Hollywood.
- **Cinema by country** — a `World Cinema` umbrella with one catalog per country (Japan, France, Italy, South Korea, Iran, Brazil, Russia, Germany, Sweden, Poland, Hong Kong, Taiwan, India, ...), each optionally further split the same way the whole project already is (Essential / Classics / Modern / Cult / New Wave / Horror).
- **Conceptual/mood catalogs** — no official ranking backs these, they're editorial groupings by theme or feel (the kind of thing Letterboxd users build lists around): Mind-Bending / Mindfuck (reality, memory, identity, time, perception), Dreamlike Cinema, Existential Cinema, Uncomfortable Cinema, Weird Cinema, Slow Cinema, Character Study, Urban Loneliness, Road Movies, Revenge, Melancholic Cinema, Feel-Good, Tearjerkers, Coming of Age. **`mindbending` is already seeded as a first example of this whole category** — it's the template to copy for the rest: no external ranking to scrape, just a hand-picked IMDb-id list with a name that does the explaining.
- **Director retrospectives**: one catalog per director (Kubrick, Tarkovsky, Bergman, Kurosawa, Lynch, ...) — same mechanism again, just a filmography instead of a themed list.

### The one thing that *can't* be done with today's code: real nesting

The idea of grouping all of the above into a browsable tree (`🏆 Greatest Films → Sight & Sound / TSPDT / IMDb / AFI`, `🌎 World Cinema → Japan / France / ...`, etc.) is worth wanting, but two things stand in the way, one at the Stremio level and one at this codebase's level:

- **Stremio's manifest format has no grouping concept.** `routes/manifest.js` emits `catalogs` as a flat array (`{ type, id, name, extra }[]`); Stremio renders each entry as its own independent row on the discover screen. There is no "folder of catalogs" a manifest can express — the closest approximation achievable today is purely cosmetic: give each catalog a `name` that sorts/reads as grouped (`"🏆 Greatest Films — Sight & Sound Top 100"`, `"🏆 Greatest Films — TSPDT Top 1000"`, ...), which is a naming convention, not real navigation.
- **`catalogs.js`'s schema is flat too** — `{ id, name, type, order, items }`, no parent/category field. Adding real hierarchy (even just for admin-side organization in `/admin`, independent of what Stremio can show) would mean extending that record shape and `routes/adminApi.js`/`routes/manifest.js` to understand it — a real schema change, not something to bolt on as a one-off.

So: any number of catalogs from the list above can be added today, for free, with the existing seed-script recipe. An actual browsable hierarchy is a separate, larger piece of work.
