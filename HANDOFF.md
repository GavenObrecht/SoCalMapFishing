# SoCal Fishing Chart — Handoff Notes

Single self-contained HTML file (`socal-fishing-chart.html`) — no build step,
no framework, no backend. Everything (HTML/CSS/JS) lives in one file. Uses
Leaflet.js for the map, plain vanilla JS for everything else.

## How it's deployed / tested

The file has no server-side component, but it makes live `fetch()` calls to
several external APIs. Browsers block those calls when the file is opened
directly (`file://` origin), so it must be served over http(s):

- Easiest path (no install): [Netlify Drop](https://app.netlify.com/drop) —
  rename the file to `index.html`, drag it onto that page, open the URL it
  gives you. No account needed.
- Any other static host or local dev server (`python -m http.server`,
  `npx serve`, Netlify CLI, Vercel, etc.) works too.

## Architecture

- `<style>` block: nautical-chart theme, CSS custom properties for the
  palette (navy/gold/teal), Oswald + IBM Plex Mono fonts from Google Fonts.
- Sidebar: filter chips (vessel range, species), MPA toggle, live-conditions
  toggles/status lines, fish count panel with day navigation.
- Map: Leaflet, custom tile layer classes (see below) plus several raw
  `<canvas>` overlays — not Leaflet layers, plain canvas elements positioned
  over the map div with their own z-index, redrawn on every `move`/`zoom`
  (or every animation frame, for currents) based on the current map view.
  Covers animated current particles, the fish-probability heatmap patches,
  the sea-surface-temp fill, and isotherm contour lines — the last three all
  draw from one shared live SST grid fetch (see Data sources below).
- `SPOTS` array: ~23 hand-curated fishing spots (mostly San Diego, plus a
  small 2026-09-15 batch extending into northern Baja — see below) with
  species, season, depth, notes. Each gets a `L.marker` with a popup; popup
  content is regenerated once live temp/wind data arrives for that spot.
- `MPA_ZONES` array: hand-traced polygons from CDFW's published corner
  coordinates for Matlahuayl SMR, San Diego–Scripps Coastal SMCA, South La
  Jolla SMCA/SMR. Approximate where the boundary follows natural coastline.
  Still San Diego-only — Mexican MPAs (CONANP reserves, a different
  regulatory system) haven't been researched/added yet.
- **`SPOTS` and `TOPO_FEATURES` (named banks/seamounts) were originally all
  San Diego-specific.** `TOPO_FEATURES` already had substantial Mexican-water
  bank coverage before 2026-09-15 too, down to ~31N (Colonet-area numbered
  spots from the SD long-range fleet's community GPS sheets). Two research
  batches on 2026-09-15 extended `SPOTS` (and, selectively, `TOPO_FEATURES`)
  the rest of the way down the peninsula:
  1. Rosarito through Ensenada/Punta Banda: 5 nearshore/kayak/small-boat
     `SPOTS` entries (Rosarito Beach Pier, La Misión, El Sauzal/San Miguel
     Reef, Islas Todos Santos, La Bufadora) plus 2 further-south offshore
     entries in both `SPOTS` and `TOPO_FEATURES` (Isla San Martín near San
     Quintín, Sacramento Reef/Isla San Jerónimo near El Rosario).
  2. San Quintín through Cabo San Lucas: 5 more offshore `SPOTS` entries
     (Isla Cedros, Isla Natividad, Bahía Magdalena/Puerto San Carlos, Gorda
     Banks, Cabo San Lucas), with Gorda Banks (Inner + Outer) also mirrored
     into `TOPO_FEATURES` as genuine seamounts.

  Both batches sourced from FishingBooker/BDOutdoors/Rosarito Beach Hotel/
  Wikipedia/Cedros- and Mag-Bay-specific charter sites, same "don't invent
  unsourced depth/species/coordinates" standard as the rest of this file —
  see the `SPOTS`/`TOPO_FEATURES` arrays' own dated comments for exactly
  what was deliberately left out (Bahía Tortugas, Magdalena Bay's named
  seamounts with no published GPS, Cabo Pulmo). Mirroring into
  `TOPO_FEATURES` was deliberately selective throughout: nearshore/kelp/surf
  spots (Rosarito, La Misión, El Sauzal, Todos Santos, La Bufadora, Cedros,
  Natividad) are NOT mirrored, for the same reason the pre-existing
  ~285-point nearshore-reef/kelp/wreck batch was left out of
  `TOPO_FEATURES` originally (see that array's own 2026-08-17 comment) — it
  would feed `bankProximityScore` for every pelagic species the way genuine
  offshore banks do. Mexican MPA zones are still unresearched — next up
  when that work resumes.
- Live data has two different fetch strategies depending on the layer:
  - **Nearshore currents and depth contours** follow the current map
    view — `getFetchBounds(padFrac)` reads `map.getBounds()` and pads it;
    `adaptiveStride()` computes each dataset's query stride from the current
    view's span so the point count requested stays roughly constant
    (~700-900 points total) whether you're zoomed into one cove or looking
    at the whole coast — that's what keeps a single query from overwhelming
    the free CORS relays (see below), not a cap on area. A debounced
    `moveend`/`zoomend` handler triggers a re-fetch only when the view has
    panned outside the last-fetched (padded) region.
  - **SST, chlorophyll, offshore-currents, the fish-probability heatmap, and
    isotherms** are deliberately NOT viewport-following — they're fetched
    once over fixed regions and stay put regardless of pan/zoom, precisely
    so the same real conditions don't get re-sampled over a different
    area/resolution just from zooming (see `HEATMAP_REGION`'s own long
    comment for the history — this used to follow the viewport too, and
    that caused visible artifacts). There are two such fixed regions —
    `HEATMAP_REGION` (San Diego through northernmost Baja) and
    `HEATMAP_REGION_SOUTH` (San Quintín through Cabo San Lucas, added
    2026-09-15) — and **both are always fetched and rendered together**,
    regardless of where the viewport currently is (`loadBothHeatmapRegions`,
    also added 2026-09-15 — every external trigger that used to call
    `loadHeatmapData` directly now goes through this instead: initial load,
    a day change, the manual refresh button). This went through two earlier,
    since-superseded designs before landing here, worth knowing if this code
    gets touched again:
    1. First, a single "active region" switch (whichever of the two the
       viewport center implied) — meant only one region's patches ever
       showed at once, so zooming out to see both San Diego and Cabo left
       half the visible coast blank.
    2. Then, a third combined `HEATMAP_REGION_FULL` region (spanning both,
       ~12°x12.5°) that the switch fell back to once the viewport got wide
       enough to see both at once — fixed the "blank half" problem, but the
       combined fetch's coarser resolution (same fixed point budget spread
       over a much bigger area) made the whole zoomed-out picture read as
       one smooth blob instead of the same tight, differentiated patches a
       close-up view shows — user asked for those to actually carry through
       when zoomed out instead.
    3. The current design gets that without duplicating every draw/score
       function: `HEATMAP_REGION` and `HEATMAP_REGION_SOUTH` are fetched
       sequentially (never concurrently — see `loadBothHeatmapRegions`'s own
       comment on why interleaving would clobber shared fetch-cycle state)
       into the SAME module-level variables (`sstGridField`,
       `heatScoreField`, etc. — the ones every scoring/marching-squares
       function already reads/writes, completely unchanged) one region at a
       time, and each region's resulting bundle of ~16 variables is
       snapshotted into `regionStore.north`/`regionStore.south`
       (`captureRegionState`/`restoreRegionState`, right after
       `isothermSegments`'s own declaration). Each of the 4 draw functions
       (`drawSstFill`, `drawHeatmap`, `drawHeatmapZones`, `drawIsotherms`) is
       split into a `*Core` function (unchanged drawing logic, operates on
       whatever's currently live) plus a thin public wrapper that clears its
       canvas once, then calls `paintBothRegions(coreFn)` — which runs
       `coreFn` against the live (just-fetched) region, then temporarily
       restores the OTHER region's own last snapshot and runs `coreFn` again
       before restoring the live region — painting both onto the same
       already-cleared canvas without either one erasing the other. Neither
       region's own resolution is affected by this at all (confirmed live:
       identical grid dimensions/finite-point counts for `HEATMAP_REGION`
       whether or not `HEATMAP_REGION_SOUTH` has ever loaded).
       `drawHeatmapZones` additionally offsets the sibling region's zone
       ranks/"Zone X of N" text so both regions' badges (up to
       `MAX_HEATMAP_ZONES` each, so up to 10 total) number continuously
       instead of each restarting at 1.

       Three follow-on bugs from the same root cause (only one region's data
       ever existed at a time, before this) were caught and fixed in the
       same change: `refreshSpotTempsFromGrid()` used to blanket-clear ALL
       spot temp badges every call, so calling it once per region left only
       the last-fetched region's spots with a badge — now each spot tracks
       its own marker and only that one gets replaced. `nearestWindSample()`
       and the click-anywhere temperature lookup both read only the live
       `sstGridField`/`windGridField` with no distance sanity check, so a
       spot or click in the region that ISN'T currently live could silently
       return the other region's data (or force a live API fallback fetch,
       eating into a real daily quota — see the Fish counts/temp table above)
       instead of gracefully finding nothing — both now also check
       `regionStore.north`/`regionStore.south`'s own snapshots.
       `TODAY_HEATMAP_CACHE_KEY` (the localStorage "today" cache) is keyed by
       region (`{date, north:{...}, south:{...}}`) so both can be cached
       simultaneously rather than one overwriting the other. `sstFieldCache`
       (the day-scrub feature's own cache, keyed only by `daysAgo`) still
       only tracks one region's data — see `prefetchDays`'s own comment —
       so the inline write to it inside `loadHeatmapData` is now guarded to
       only fire for whichever region `activeHeatmapRegion()` (the old
       viewport-based single-region guess, kept around just for this) would
       currently pick, otherwise south's write would always win regardless
       of where the viewport actually is.

       A short (1.5s) delay was added between the two regions' fetches
       after confirmed-live testing showed firing both bursts of requests
       (SST/chlorophyll/currents/wind, each racing up to 3 relays) back to
       back roughly doubled how often the relay chain/Worker returned 429s —
       doesn't fix relay flakiness in general (see below), just spaces out
       the extra load this change itself introduced.
  Each fetch function takes a `generation` number (`heatmapFetchGeneration` /
  `currentsFetchGeneration`) captured at the moment it was kicked off, and
  only commits its result to global state if that's still the *current*
  generation when the response lands — without this, switching regions or
  panning quickly (e.g. Cabo then Santa Barbara before Cabo's slower relay
  round-trip finishes) let an older region's response land last and
  silently overwrite a newer region's correct data. Caught in testing
  before shipping; covered by the guard now.

## Data sources (all live, no API keys)

| Feature | Source | Notes |
|---|---|---|
| Base map (satellite) | Esri World Imagery tiles | Standard tile layer |
| Base map | Esri World Imagery (satellite) only | The only base layer as of 2026-09-10 — "Chart (dark)" (briefly Esri's dark-gray canvas basemap, itself a same-day replacement for CartoDB's `dark_all` after CARTO started requiring an API key) and "Contour lines" (a NOAA ENC nautical-chart overlay, US coastal waters only) were both removed per direct request. `L.control.layers`, the base-layer picker, is gone too — nothing left to pick between. |
| Bathymetry | NOAA NCEI DEM mosaic (`gis.ngdc.noaa.gov` ImageServer, dataset `DEM_global_mosaic_hillshade`, `ColorHillshade` rendering rule) | Custom `L.TileLayer` subclass building `exportImage` requests per tile (EPSG:3857). Was `DEM_tiles_mosaic_hillshade` until 2026-09-09 — that mosaic has no source raster at all over San Diego/SoCal (confirmed via its `/identify` endpoint: "NoData", empty catalog), so every tile there came back a silently-transparent 200 OK and the layer toggle appeared to do nothing. Worth remembering for any other `gis.ngdc.noaa.gov` dataset added later: a 200 status doesn't mean real pixels — check the actual decoded image or the `/identify` endpoint for the specific area of interest. |
| Depth contour lines | Same NGDC ImageServer, dataset `DEM_global_mosaic` (the non-hillshade sibling), via its `getSamples` batch point-sampling operation | Added 2026-09-10 replacing the old ENC-based "Contour lines" base layer, to get real bathymetric isobaths covering wherever the map is panned (global data) instead of one chart product's fixed coverage area. `getSamples` takes a batch of point coordinates and returns raw elevation values in one request — a 25x25 (625-point) grid resolves in ~2s. Must be POSTed, not GET — a GET request for the same grid 414'd (URI too long). Elevation is converted to depth-in-feet (same `* 3.28084` conversion the click-anywhere depth popup uses) and contour-traced client-side with the same marching-squares approach `computeIsothermSegments` already uses for temperature, just with dynamic "nice number" depth-interval steps (10ft to 20,000ft) instead of one fixed step, since depth range varies far more per-view than SST does. Off by default (`bathyContourToggle` in the legend), fetched lazily on first enable, then kept in sync with the viewport the same way `loadCurrents` is (debounced re-fetch on `moveend`/`zoomend` when panned outside the last-fetched area). |
| Sea surface temp (map layer) | NOAA CoastWatch ERDDAP griddap, dataset `jplMURSST41` (same JSON grid fetch as the heatmap/isotherms — see below) | Rendered as our own canvas fill, not NOAA's WMS tiles — their WMS ignores `colorscalerange` overrides (confirmed by diffing GetMap responses byte-for-byte), so a custom legend range couldn't be made to match the actual tile colors. The canvas fill guarantees the legend and the map always agree. |
| Surface currents (animated, nearshore) | NOAA/Scripps CORDC HFRNet, ERDDAP dataset `ucsdHfrW2` (`coastwatch.pfeg.noaa.gov`) | **Fragile** — see Known Issues. Only covers a narrow strip close to the SD coast (bbox roughly 32.3-33.0N, 117.6-117.0W). |
| Surface currents (offshore fallback, feeds fish-probability model only) | NOAA/Miami near-real-time geostrophic currents, ERDDAP dataset `miamicurrents` | Coarse (~0.2deg), altimetry-derived, updates daily. `fieldAt()` tries the nearshore HFR field first, falls back to this outside the HFR bbox — covers Tanner/Cortes Banks and beyond, where far-ranging pelagics (bluefin) actually range. Not shown as its own visual layer, just widens where the model has real current data instead of guessing. |
| Chlorophyll concentration | NOAA CoastWatch ERDDAP griddap, dataset `noaacwNPPN20VIIRSDINEOFDaily` on `coastwatch.noaa.gov` (VIIRS, gap-filled DINEOF, ~9km, near-real-time, ~1-2 day lag) — moved here 2026-09-09 after NOAA relocated the old `coastwatch.pfeg.noaa.gov`/`nesdisVHNnoaaSNPPnoaa20NRTchlaGapfilledDaily` URL, which now just 302-redirects | Same fetch/proxy pattern as SST. Feeds two things: (1) a "color break" gradient score in the fish-probability model (log-space local gradient — captains chase the blue-water/green-water edge, not raw concentration), weighted per species in `FISH_PREFERENCES.chlaWeight`; (2) an optional log-scaled canvas fill layer, off by default so it doesn't visually compete with the SST fill. |
| Exact temp/wind at spots + click-anywhere | Open-Meteo Marine API (`marine-api.open-meteo.com`) + Forecast API (`api.open-meteo.com`) | Both explicitly support direct browser CORS, no proxy needed |
| Depth at click | OpenTopoData GEBCO2020 (`api.opentopodata.org`) | Direct fetch attempted first, proxy fallback added defensively |
| Fish counts | Scraped from `sandiegofishreports.com/dock_totals/boats.php?date=YYYY-MM-DD` | **Fragile** — see Known Issues |

### Datasets checked and rejected as not live enough

Before adding chlorophyll/currents, several NOAA CoastWatch ERDDAP datasets were checked directly (not from memory — queried `.../griddap/{id}.json?time[(last)]` for the true latest data point, since the `.das` metadata's `time_coverage_end` attribute can itself be stale). All rejected for being stale, not for CORS/access reasons:
- `nesdisSSH1day` (sea surface height anomaly + geostrophic currents) — stuck ~4 months behind, likely discontinued despite being labeled "2017-present".
- `osu2SstAnom` / `osu2ChlaAnom` (West Coast SST/chlorophyll anomaly) — stuck ~6 weeks behind.
- `jplOscar` (OSCAR sea surface velocity) — stuck since 2014 on this ERDDAP mirror.
- `erdVHNchla1day` (North Pacific VIIRS chlorophyll, non-gap-filled) — stuck ~6 weeks behind; the gap-filled DINEOF variant used instead updates within ~1-2 days.

A true SST/chlorophyll *anomaly* layer (value minus historical-normal-for-this-date) is still not implemented — no live-updating anomaly product was found, but it could be computed client-side by subtracting a static climatology baseline from the SST/chlorophyll grids already being fetched, if wanted later.

## The CORS proxy problem

Several target servers (`coastwatch.pfeg.noaa.gov`/`coastwatch.noaa.gov` for
SST/chlorophyll/currents, `sandiegofishreports.com` for fish counts) don't
send `Access-Control-Allow-Origin`, so direct browser `fetch()` calls are
blocked regardless of what origin the page is served from. Workaround in
place: `fetchJsonViaProxies()` / `fetchTextViaProxies()` race, in order:

1. `cloudflare-worker-proxy.js`, self-hosted at
   `socalmapfishing-proxy.gaven-obrecht.workers.dev` — this **is** the real
   fix described below; it already exists and is deployed, listed first
   since it's fastest when it works.
2. `https://api.allorigins.win/raw?url=<url>`
3. `https://api.codetabs.com/v1/proxy?quest=<url>`

(A fourth relay, `corsproxy.io`, was removed from this list 2026-09-09 —
confirmed live it now 401s every request, requiring a paid API key.)

These free public relays have no SLA — they can be slow, rate limited, or
briefly down — but with the Worker racing alongside them (and its own
per-host edge cache absorbing repeat queries), this is much less of a
bottleneck than it used to be.

**Already done**: the "stand up a tiny serverless function" fix this section
used to recommend is `cloudflare-worker-proxy.js` above — deployed, in the
active race, allowlisted to the specific hosts this app needs. Further
improving reliability from here means tuning that Worker (cache TTLs, retry
counts, allowlisted hosts) rather than building a new one.

## Known issues / where to focus next

1. **Currents (and SST/chlorophyll/heatmap generally)** — the biggest pain
   point this whole build. Query stride now adapts to the current view's
   span (see `adaptiveStride()`/`getFetchBounds()` above) to keep point
   counts bounded regardless of area, but still gets occasional timeouts
   from the free relays (the self-hosted Worker helps a lot but isn't
   perfectly reliable either), especially right after a pan/zoom fires a
   fresh fetch cycle. As of 2026-09-14, `loadCurrents()` (the animated
   nearshore-currents layer specifically) no longer goes blank on a failed
   refresh — it now keeps whatever's already on screen and labels it with
   how stale it is (`lastGoodCurrentsTime`), and a cold page load seeds
   itself instantly from a same-day `localStorage` cache
   (`TODAY_CURRENTS_CACHE_KEY`) while the live fetch is still in flight, the
   same "instant paint from cache, refine when live" pattern
   `TODAY_HEATMAP_CACHE_KEY` already used for SST/chlorophyll/offshore-
   currents. Confirmed live via headless-browser testing with the relay
   hosts deliberately blocked (see below) — do NOT call
   `initCurrentParticles()` synchronously from that cold-start seed path
   without first `await`-ing a microtask; doing so throws a temporal-dead-
   zone `ReferenceError` on `offshoreCurrentField` (declared later in the
   file), since it'd run before the rest of the script has finished its
   initial top-to-bottom pass — easy to reintroduce if this code gets
   refactored. Also worth checking periodically: NOAA has silently
   relocated at least two ERDDAP datasets this app depends on so far
   (offshore currents 2026-09-01, chlorophyll 2026-09-09 — both just
   started 302-redirecting instead of returning data), so "a layer stopped
   loading" is now a known failure mode worth checking with a direct `curl`
   before assuming it's just relay flakiness again.

2. ~~**Fish counts** — unconfirmed working live~~ — confirmed 2026-09-14 via
   a real headless-browser run against the deployed parser: all four
   landings populate with real boat/trip/angler/fish data (H&M 12 boats,
   Fisherman's 9, Point Loma 3, Seaforth 11 on the day tested), zero console
   errors. The link-scanning approach (matching each row's landing `<a
   href>` against known URL slugs) does correctly identify rows even for
   H&M Landing's literal unescaped `&` in its URL slug (`h&m_landing.php`).

3. **Depth at click** — OpenTopoData's CORS support was never explicitly
   confirmed; a proxy fallback was added but also not yet confirmed working
   live.

4. **MPA polygon accuracy** — traced from CDFW's published corner
   coordinates but simplified as straight lines where the real boundary
   follows the coastline. Good enough to plan around, not survey-grade.
   South La Jolla SMCA/SMR in particular is a rough approximation — CDFW's
   site has the authoritative boundary if it needs tightening.

5. **Spot coordinates** — hand-placed from research, not from a mapping
   service. A couple were caught sitting on land/inside MPAs during this
   build and corrected; worth a final pass checking the rest against a real
   map if precision matters.

6. **`HEATMAP_REGION_SOUTH`/dual-region rendering (Cabo San Lucas extension,
   2026-09-15)** — `HEATMAP_REGION_SOUTH`'s SST cells are coarser than
   `HEATMAP_REGION`'s (~3-4km vs ~1-2km, since `adaptiveStride()` spreads the
   same point budget over a larger span — see that constant's own comment)
   and chlorophyll/offshore-currents are coarser still (~37km/~56km cells
   respectively) — expected, not a bug, matches the size of the real area it
   covers. Both regions are always fetched and rendered together now (see
   `loadBothHeatmapRegions`/`paintBothRegions` in the architecture section
   above) — confirmed live via headless-browser testing across many runs:
   `regionStore.north`/`.south` both populate with real, distinct, mostly-
   finite SST/chlorophyll/offshore-current grids and real heatmap
   scores/zones; a close-up San Diego view keeps `HEATMAP_REGION`'s exact
   original resolution whether or not `HEATMAP_REGION_SOUTH` has ever loaded
   (identical grid dimensions/finite-point count either way — confirms the
   two are genuinely fetched independently, never merged); zoomed out to see
   both San Diego and Cabo at once, real heatmap patches now show across the
   whole visible coast with continuous zone numbering (1..10) instead of
   only whichever region the center happened to be over. Firing both
   regions' fetches back to back did measurably increase how often the
   relay chain/Worker returns 429s (a 1.5s gap between them was added to
   reduce, not eliminate, this); a transient failure on either region's
   fetch correctly falls back to that region showing nothing (or its own
   last-good stale data) rather than corrupting the other region's data or
   erroring the whole page — confirmed live by deliberately hitting a run
   where south's fetch 502'd/429'd repeatedly while north's succeeded
   normally. Nearshore animated current arrows have no coverage at all south
   of the SD area (same ~30.25N HFRNet cutoff as before) and correctly show
   a "relays failed" status there rather than the wrong data. Known
   remaining gap: `sstFieldCache` (the day-scrub feature's own cache) still
   only tracks one region's data at a time — see `prefetchDays`'s own
   comment — so day-scrub playback while viewing the region `activeHeatmapRegion()`
   *wouldn't* currently guess (e.g. scrubbing days while looking at Cabo,
   since that function still guesses based on viewport center the old
   single-region way) falls back to a live per-day fetch instead of the
   instant cached swap San Diego gets. Extending day-scrub to be truly
   dual-region-aware wasn't done — out of scope for what was asked, and a
   real feature, not just a docs gap.

## Suggested next steps

- ~~Build the small CORS-proxy backend described above~~ — done
  (`cloudflare-worker-proxy.js`), live and in the active proxy race.
- ~~Verify the fish-count parser against real rendered HTML~~ — done,
  confirmed working live 2026-09-14.
- ~~Cache last-successful fetches~~ — done 2026-09-14, see "Stale-data
  caching" below.
