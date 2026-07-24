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
- Map: Leaflet, custom tile layer classes (see below) plus a raw `<canvas>`
  overlay for animated current particles (not a Leaflet layer — a plain
  canvas element positioned over the map div, redrawn every animation frame
  based on the current map view).
- `SPOTS` array: ~17 hand-curated San Diego fishing spots with species,
  season, depth, notes. Each gets a `L.marker` with a popup; popup content
  is regenerated once live temp/wind data arrives for that spot.
- `MPA_ZONES` array: hand-traced polygons from CDFW's published corner
  coordinates for Matlahuayl SMR, San Diego–Scripps Coastal SMCA, South La
  Jolla SMCA/SMR. Approximate where the boundary follows natural coastline.

## Data sources (all live, no API keys)

| Feature | Source | Notes |
|---|---|---|
| Base map (satellite) | Esri World Imagery tiles | Standard tile layer |
| Base map (chart) | CartoDB dark tiles | Standard tile layer |
| Bathymetry | NOAA NCEI DEM mosaic (`gis.ngdc.noaa.gov` ImageServer, `ColorHillshade` rendering rule) | Custom `L.TileLayer` subclass building `exportImage` requests per tile (EPSG:3857) |
| Sea surface temp (map layer) | NOAA CoastWatch ERDDAP WMS, dataset `jplMURSST41` | Custom `L.TileLayer` subclass — this WMS server needs `CRS=EPSG:4326` explicitly; Leaflet's default WMS layer requests EPSG:3857 and silently fails against this server |
| Surface currents (animated) | NOAA/Scripps CORDC HFRNet, ERDDAP dataset `ucsdHfrW2` (`coastwatch.pfeg.noaa.gov`) | **Fragile** — see Known Issues |
| Exact temp/wind at spots + click-anywhere | Open-Meteo Marine API (`marine-api.open-meteo.com`) + Forecast API (`api.open-meteo.com`) | Both explicitly support direct browser CORS, no proxy needed |
| Depth at click | OpenTopoData GEBCO2020 (`api.opentopodata.org`) | Direct fetch attempted first, proxy fallback added defensively |
| Fish counts | Scraped from `sandiegofishreports.com/dock_totals/boats.php?date=YYYY-MM-DD` | **Fragile** — see Known Issues |

## The CORS proxy problem

Several target servers (`coastwatch.pfeg.noaa.gov` for currents,
`sandiegofishreports.com` for fish counts) don't send
`Access-Control-Allow-Origin`, so direct browser `fetch()` calls are blocked
regardless of what origin the page is served from. Workaround in place:
`fetchJsonViaProxies()` / `fetchTextViaProxies()` try, in order:

1. `https://api.codetabs.com/v1/proxy?quest=<url>`
2. `https://corsproxy.io/?url=<url>`
3. `https://api.allorigins.win/raw?url=<url>`

These are free public relay services with no SLA — they can be slow, rate
limited, or briefly down. This is the single biggest source of flakiness in
the app.

**Recommended real fix**: stand up a tiny serverless function (Cloudflare
Worker, Netlify Function, Vercel Edge Function — a few lines of code) that
proxies these two specific requests server-side. That removes the dependency
on third-party relay uptime entirely and would meaningfully improve
reliability for both currents and fish counts.

## Known issues / where to focus next

1. **Currents** — the biggest pain point this whole build. The HFR dataset
   query was narrowed (smaller bbox, coarser stride) to fit inside relay
   timeout windows, which limits currents display to the immediate San Diego
   coast. Still gets occasional `HTTP 408` from all three relays. A proper
   proxy (see above) would likely fix this outright, since the underlying
   NOAA server itself responds fine — it's specifically the free relays
   timing out.

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

- Build the small CORS-proxy backend described above; point currents and
  fish counts at it instead of the public relays.
- Verify the fish-count parser against real rendered HTML (this is exactly
  the kind of thing a coding agent with real browser/devtools access can
  nail quickly, versus my having to infer structure from a text-extraction
  tool).
- Consider caching last-successful fetches (localStorage or similar) so the
  UI has something to show immediately while live data loads, and doesn't
  go blank if a relay is briefly down.
