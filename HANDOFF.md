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
- `SPOTS` array: ~17 hand-curated San Diego fishing spots with species,
  season, depth, notes. Each gets a `L.marker` with a popup; popup content
  is regenerated once live temp/wind data arrives for that spot.
- `MPA_ZONES` array: hand-traced polygons from CDFW's published corner
  coordinates for Matlahuayl SMR, San Diego–Scripps Coastal SMCA, South La
  Jolla SMCA/SMR. Approximate where the boundary follows natural coastline.
- **`SPOTS`, `MPA_ZONES`, and `TOPO_FEATURES` (named banks/seamounts) are all
  San Diego-specific and don't extend with the live data layers below.** The
  live SST/chlorophyll/currents/heatmap data now covers wherever you pan
  (Cabo to Central California and beyond — see next section), but there's no
  hand-curated spot/structure/MPA data for that wider area. Extending those
  would be a separate research effort, not a data-fetch change.
- Live data (SST, chlorophyll, currents, heatmap, isotherms) follows the
  current map view instead of one fixed region — `getFetchBounds(padFrac)`
  reads `map.getBounds()` and pads it; `adaptiveStride()` computes each
  dataset's query stride from the current view's span so the point count
  requested stays roughly constant (~700-900 points total) whether you're
  zoomed into one cove or looking at the whole coast — that's what keeps a
  single query from overwhelming the free CORS relays (see below), not a cap
  on area. A debounced `moveend`/`zoomend` handler triggers a re-fetch only
  when the view has panned outside the last-fetched (padded) region.
  Each fetch function takes a `generation` number (`heatmapFetchGeneration` /
  `currentsFetchGeneration`) captured at the moment it was kicked off, and
  only commits its result to global state if that's still the *current*
  generation when the response lands — without this, panning quickly (e.g.
  Cabo then Santa Barbara before Cabo's slower relay round-trip finishes)
  let an older region's response land last and silently overwrite a newer
  region's correct data. Caught in testing before shipping; covered by the
  guard now.

## Data sources (all live, no API keys)

| Feature | Source | Notes |
|---|---|---|
| Base map (satellite) | Esri World Imagery tiles | Standard tile layer |
| Base map (chart) | CartoDB dark tiles | Standard tile layer |
| Bathymetry | NOAA NCEI DEM mosaic (`gis.ngdc.noaa.gov` ImageServer, dataset `DEM_global_mosaic_hillshade`, `ColorHillshade` rendering rule) | Custom `L.TileLayer` subclass building `exportImage` requests per tile (EPSG:3857). Was `DEM_tiles_mosaic_hillshade` until 2026-09-09 — that mosaic has no source raster at all over San Diego/SoCal (confirmed via its `/identify` endpoint: "NoData", empty catalog), so every tile there came back a silently-transparent 200 OK and the layer toggle appeared to do nothing. Worth remembering for any other `gis.ngdc.noaa.gov` dataset added later: a 200 status doesn't mean real pixels — check the actual decoded image or the `/identify` endpoint for the specific area of interest. |
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
   fresh fetch cycle. Also worth checking periodically: NOAA has silently
   relocated at least two ERDDAP datasets this app depends on so far
   (offshore currents 2026-09-01, chlorophyll 2026-09-09 — both just
   started 302-redirecting instead of returning data), so "a layer stopped
   loading" is now a known failure mode worth checking with a direct `curl`
   before assuming it's just relay flakiness again.

2. **Fish counts** — parser was rewritten to identify each landing by
   scanning for a link inside each table row (matching against known landing
   URL slugs) rather than assuming specific heading tags, since the first
   two markup-structure assumptions were wrong. This was **not yet confirmed
   working live** as of handoff — last user report was mid-debugging this
   exact fix. If it's still returning "No data found," the next step is to
   get the actual rendered DOM structure (e.g. via a headless browser or
   browser devtools) rather than guessing again — I was only ever able to
   inspect this site through a markdown-converting fetch tool, never real
   HTML source, which is the root cause of the repeated wrong guesses.

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

## Suggested next steps

- ~~Build the small CORS-proxy backend described above~~ — done
  (`cloudflare-worker-proxy.js`), live and in the active proxy race.
- Verify the fish-count parser against real rendered HTML (this is exactly
  the kind of thing a coding agent with real browser/devtools access can
  nail quickly, versus my having to infer structure from a text-extraction
  tool).
- Consider caching last-successful fetches (localStorage or similar) so the
  UI has something to show immediately while live data loads, and doesn't
  go blank if a relay is briefly down.
