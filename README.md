# VRS Lab

An unofficial, interactive explorer for the Counter-Strike 2 **Valve Regional Standings (VRS)**.

It turns Valve's published markdown snapshots into a readable score breakdown: the four seed
factors, the head-to-head adjustment, every match that contributed, prize winnings, and rank
history. It does **not** recompute the ranking.

## Status

Static prototype — no build step, no framework. An optional local Python service adds automatic
updates when Valve publishes a new monthly snapshot.

- `index.html` — shell
- `styles.css` — design system
- `app.js` — router, rendering, charts (hash routes: `#/`, `#/team/:id`, `#/compare`, `#/methodology`)
- `data.js` — generated data bundle (~6.5 MB)
- `data/meta.json` — build metadata (`latestDate`, `builtAt`, counts) read by the updater and the page
- `scripts/build_data.py` — data pipeline
- `scripts/validate_data.py` — invariant checks
- `scripts/dev_server.py` — local server with caching disabled, live update API, and auto rebuild

## Features

- Rankings with region tabs, snapshot picker, sort, team/player search, movement, sparklines,
  and a four-factor mini profile.
- Team pages with a score waterfall, factor cards, roster-vs-org history lines, and every match
  in the official detail file.
- Multi-team comparison for **2–4 rosters**: factor radar, per-factor bars, score equation,
  common opponents, a head-to-head matrix, and a multi-series rank chart. The selection is
  shareable via `#/compare?t=id1,id2,…`.
- Major invite lines on regional tables, using the last published allocation (Winter 2025).
- A methodology page that separates official data from this site's own visualizations.

## Run it

```powershell
python scripts/dev_server.py --port 5173
# then open http://127.0.0.1:5173/
```

`dev_server.py` sends `no-store` headers and appends file mtimes to asset URLs, so edits show up
on reload. A plain `python -m http.server 5173 --bind 127.0.0.1` also works, but the browser may
keep stale copies of `data.js` / `app.js`, and live updates are disabled.

## Live updates

The local service checks Valve's official repository for a newer snapshot every 30 minutes
(`--interval` changes this, minimum 60 seconds). When a newer snapshot date appears it runs
`scripts/build_data.py` and writes `data/meta.json`; open pages notice the new `builtAt` and
hot-swap to the rebuilt `data.js` without a full reload.

- `GET /api/meta` — build metadata plus updater state (`checking`, `building`, `lastCheck`,
  `remoteLatest`, `lastError`)
- `POST /api/check` — ask the updater to check now
- Sidebar status button — click to check manually; green means synced, orange means a check or
  rebuild is running, grey means the live service is not reachable (static hosting)
- `data/update.log` — stdout/stderr of the last automatic rebuild
- `--no-watch` — serve files only, never check or rebuild

A failed check retries after 5 minutes; a normal check waits for the configured interval. If the
page is served statically (Gitee Pages, `python -m http.server`), it shows “Static build” and keeps
working with whatever `data.js` was last generated — rebuild and redeploy to publish a new month.

## Rebuild the data

```powershell
python scripts/build_data.py
python scripts/validate_data.py
```

The pipeline reads the official repository through the jsDelivr CDN (raw.githubusercontent is
unreachable from some networks). Every downloaded file is cached under `data/raw/`, so reruns are
fast and offline-safe. Delete `data/raw/` to force a refresh.

Snapshot coverage is 2024-08-06 → 2026-11-02 (48 snapshots). Full match detail is parsed only for
the latest snapshot; older snapshots are used for rank history.

## Data model

| Concept | Definition |
| --- | --- |
| Roster id | `sha1(sorted(lowercase nicknames))`, prefixed `r`. A roster change creates a new entity. |
| Org trend | Rank series keyed by normalized team name. Visual aid only — it is not an identity. |
| Points | Integer shown in the standings table. |
| Final rank value | Decimal in the detail file; `points ≈ round(final)`. |

Rosters are identified by player set, not by organization name, because VRS itself is
roster-based. Duplicate names (`OG`, `Sashi`, `BRUTE`, …) are therefore expected and kept apart.

## Validation

`scripts/validate_data.py` checks, for the latest snapshot:

- `final == starting + h2h` (tolerance 0.15)
- `factor average == mean(four factors)` (tolerance 0.002)
- `points ≈ final` (tolerance 0.5, because the detail page rounds to one decimal)
- region totals, duplicate roster keys, roster sizes, history coverage

Current result: 376/376 teams pass all three numeric invariants; 244 Europe / 87 Americas / 45 Asia.

## Qualification lines

`data/qualification.json` holds the only officially published Major invite allocation (the Winter
2025 table from the CS Major Supplemental Rulebook). It is embedded into the bundle as
`payload.qualification` and rendered as:

- dashed **Stage 3 / Stage 2 / Stage 1 lines** in regional standings (only when the region tab is
  active, the table is sorted by rank, and no search is applied),
- a **Major path** card in the rankings sidebar,
- a badge on team pages and in the comparison summary,
- the allocation table on the methodology page.

Valve recalculates this allocation for every Major cycle from the previous Major's regional
results, so the lines are labeled with their `asOf` date and are **not** a live qualification or a
prediction.

## Known limitations

- Official detail tables have **no event names**, so match rows are grouped only by date,
  opponent, and event weight.
- Only the latest snapshot carries full match/factor detail.
- The bundle is a single ~6.5 MB script. Fine for a prototype; a real deployment should serve an
  API and paginate.
- Valve can change the model or the file format at any time.

## Provenance & disclaimer

Standings and detail files:
<https://github.com/ValveSoftware/counter-strike_regional_standings>

The detail files state that event data for Regional Standings is provided by **HLTV.org**.

This is an unofficial fan-made prototype. It is not affiliated with, endorsed by, or supported by
Valve, HLTV, or any tournament organizer. Do not use it for official invitations, eligibility, or
seeding decisions.

The official repository has **no LICENSE file**. Its code is source-available, not open source.
This project does not copy that code; it only reads the published data files.
