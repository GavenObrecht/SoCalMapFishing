# SoCal Map Fishing

An interactive nautical chart of San Diego fishing spots — vessel range and
target species filters, marine protected area boundaries, live sea surface
temperature and surface currents, bathymetry, and daily fish counts scraped
from local landings.

Single self-contained file (`index.html`) — no build step, no framework, no
backend. Uses [Leaflet.js](https://leafletjs.com/) for the map and vanilla JS
for everything else.

## Running it

The page makes live `fetch()` calls to external APIs, which browsers block
when the file is opened directly (`file://`). Serve it over http(s) instead:

- Drag `index.html` onto [Netlify Drop](https://app.netlify.com/drop) (no
  account needed), or
- Any static host / local dev server: `python -m http.server`, `npx serve`,
  GitHub Pages, Vercel, etc.

## More detail

See [`HANDOFF.md`](./HANDOFF.md) for architecture notes, data sources, known
issues, and suggested next steps.
