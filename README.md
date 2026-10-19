# UIUC Library Hours

One page showing live opening hours for every University of Illinois Urbana-Champaign library:
who's open right now, when each closes or opens next, and the full 7-day schedule.

## Features
- Live "open now / closes at / opens at" status in campus (Central) time, refreshed every 30 seconds
- "X of 24 libraries open right now" summary
- Search by library, building, or address; "Open now" filter; sort by open-first or A–Z
- Card view (with expandable weekly hours, links, phone, study rooms) and a week-at-a-glance table
- Favorites: star libraries to pin them to the top (saved in your browser)
- Map view: color-coded pins for every library, grouped by building, with hours in each popup
- Works on phones; light and dark mode

## Data source
Hours come from the University Library's public directory API
(`https://libdirectory.library.illinois.edu/Api/UnitsInGateway`), the same one behind
<https://www.library.illinois.edu/hours/>. The API has no CORS headers but supports JSONP,
so the site is fully static with no backend.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## Deploy
It's just `index.html`, `styles.css`, and `app.js`, so any static host works
(GitHub Pages, Netlify, Vercel, Cloudflare Pages).

When you change `app.js` or `styles.css`, bump the `?v=` number on them in `index.html`.
GitHub Pages lets browsers cache files for 10 minutes, and the new number makes them fetch the update.
