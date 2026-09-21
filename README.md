# SRR Gutter Estimator

A single-page static site that gives a homeowner an instant, itemized gutter
estimate from Specialist Roofing & Repair.

**Status: all 7 phases complete. Live at
<https://marcusmgrant.com/srr-gutter-estimator/>.**

Original status note: Phase 6 (map and confirm) was built ahead
of phase 5 because [what phase 4 measured](#what-phase-4-measured) showed the
confirm step is load-bearing, not cosmetic. Only phase 7 (copy pass) remains.

A customer can type an address, see their building outlined on satellite
imagery, correct it if we picked the wrong one, switch off walls that have no
gutter, type their own perimeter, fall back to floor area when there is no
outline, pick a roof type, and get an itemized price with a downloadable
statement of work. Every step shows its working and every step is overridable.

## Hard constraints this is built under

- Static only. GitHub Pages, no server, no database, no functions.
- **Zero cost and no billing account anywhere.** No Maps key, no Mapbox token,
  no credit card on file. Any library or endpoint that asks for a key is
  disqualified.
- No API keys in the repo, at all.
- No build step. Clone, edit a file, push.
- Mobile first.
- The output is an estimate, never a binding quote.

## Running it locally

```bash
npx --yes http-server . -p 8080 -c-1
```

Then open <http://localhost:8080>. It has to be served over HTTP, not opened as
a `file://` URL, because it uses ES modules and `fetch`.

```bash
npm test
```

## How pricing works

There is **no price anywhere in the source code**. Everything comes from
`SRR_Gutter_Pricing_Config.xlsx`, which lives in Google Sheets and is edited by
the owner.

At page load the site tries, in order:

1. The published Google Sheet, via the keyless gviz CSV endpoint.
2. `sessionStorage`, if the sheet was already fetched this session.
3. The committed `data/pricing.csv` and `data/rules.csv` snapshots, with a
   visible footer notice that pricing may be out of date.

`?refresh=1` bypasses the session cache. That is how you confirm a price edit
actually went live.

### Connecting the sheet

The workbook is already in Google Sheets:

<https://docs.google.com/spreadsheets/d/1z8CM75Y2F5pTDn4EAZAa60b_io_aqSGOica2b4N5t-A/edit>

It has five tabs. `README`, `Rules` and `Pricing` are the ones you edit.
`Web_Pricing` and `Web_Rules` are **live mirrors with the margin data stripped
out** — they exist so the site can be fed without publishing SRR's cost basis.

**One-time fix needed:** the `QUERY` formula in `Web_Pricing!A2` and
`Web_Rules!A2` did not survive the .xlsx import and shows `#NAME?` / an error.
Click each cell and retype it:

`Web_Pricing!A2`

```
=QUERY(Pricing!A2:K,"select A,B,C,D,E,F,G,I,J,K where A is not null",0)
```

`Web_Rules!A2`

```
=QUERY(Rules!A2:C,"select A,B,C where A is not null and A <> 'target_margin'",0)
```

Then pick one of two ways to connect it, in `config.js`:

**Route 1 — published CSV (recommended).** The document stays private; only the
two mirror tabs go public.

1. File > Share > Publish to web
2. Publish **`Web_Pricing`** as Comma-separated values (.csv). Copy the URL.
3. Repeat for **`Web_Rules`**.
4. Paste both into `PRICING_CSV_URL` and `RULES_CSV_URL` in `config.js`.

**Route 2 — link sharing (simpler, less private).** Share the document as
"Anyone with the link can view" and leave `SHEET_ID` as it is. The site reads
the `Web_*` tabs, so the estimator still never sees cost data — but **anyone
with the link can open the `Pricing` tab and read `Unit Cost` directly**. Only
use this if that is acceptable.

Until one of these is done the site runs off the committed snapshots and says
so in the footer. It never quotes a wrong number because of it.

`config.js` is committed on purpose. The sheet id is not a secret, and Pages
can only serve files that are in the repo. There are no keys in it.

### Keeping the fallback fresh

```bash
npm run snapshot
```

Pulls the live sheet into `data/*.csv`. Commit the result. It refuses to write
if any `Price` fails to parse, so a broken sheet cannot silently overwrite a
good snapshot.

To rebuild the snapshots from the local `.xlsx` instead of the live sheet:

```bash
python scripts/seed-from-xlsx.py
```

The `.xlsx` is **not tracked in git** — Google Sheets is the source of truth
now, and the workbook holds `Unit Cost` and `target_margin`, which must not be
published. It is still on disk locally as the bootstrap seed.

### Margin privacy

`Unit Cost` and `target_margin` are **stripped at every layer** — by the
snapshot script, by the seed script, and again by the runtime parser in
`src/config.js`. They never enter `data/*.csv`, never enter browser memory, and
never enter the DOM.

This matters more than the workbook README suggests: `data/` is served
publicly by GitHub Pages, so anything committed there is world-readable. The
estimator reads `Price` only, so nothing is lost by dropping cost data
entirely.

## Repository layout

```
index.html
config.js                  SHEET_ID only, committed, no keys
config.example.js          template
assets/styles.css
src/main.js                entry, wiring
src/config.js              loads + validates pricing and rules
src/providers.js           every external endpoint, one line each
src/estimator.js           pure pricing engine, no DOM, no fetch
src/ui.js                  rendering and form state
src/sow.js                 statement of work text, pure
src/geo.js                 geocode, footprint, perimeter maths
src/map.js                 Leaflet, optional by design
assets/logo.png            Specialist Roofing & Repair logo
data/pricing.csv           committed fallback snapshot
data/rules.csv             committed fallback snapshot
scripts/geo-probe.mjs      headless hit-rate probe for the address chain
scripts/snapshot.mjs       refresh the fallback from the live sheet
scripts/seed-from-xlsx.py  rebuild the fallback from the workbook
tests/
```

`src/estimator.js` is pure: config in, inputs in, result out. No fetch, no DOM.
That is what makes the numbers auditable and the tests meaningful.

## Build status

| # | Phase | State |
|---|---|---|
| 1 | Scaffold, config loader, CSV fallback, rules object | **done** |
| 2 | Pricing engine + tests, manual linear feet only | **done** |
| 3 | Results table and statement of work download | **done** |
| 4 | Geocode + Overpass footprint + perimeter maths, headless | **done** |
| 5 | Roof factor, editable chain, square footage fallback | **done** |
| 6 | Leaflet map with outline overlay and confirm step | **done** (built before phase 5, deliberately) |
| 7 | Mobile polish, branding, copy | **done** |

## Open items found while building phase 1

These are gaps between the spec and the actual workbook, not guesses.

1. ~~Six rule keys from spec section 6 are missing~~ **Resolved.**
   `gutter_factor_gable` (0.62), `gutter_factor_hip` (1.00),
   `gutter_factor_flat` (0.95), `gutter_factor_unknown` (0.80),
   `overhang_allowance_ft` (1.0) and `footprint_shape_factor` (1.12) are now in
   the workbook's Rules tab and in the live Google Sheet, so they are tunable
   without touching code. The values are still the spec's guesses — see the
   calibration ask below.

2. ~~`company_phone` and `company_license` are `TBD`~~ **Resolved.** Both were
   filled in from specialistroofing.com: phone `(747) 335-0597`, licence
   `1007386`. **Confirm the phone is the right one for gutter leads** — it is
   the site's main line, and the footer also lists `(626) 869-7663`.

3. **Acceptance test 3 in the spec does not hold against real pricing.** A 40 LF
   single-storey aluminium K Style 5" job comes to $1,083.44 before rounding
   (44 LF gutter at $16.36 = $719.84, plus 20 LF of downspout at $18.18 =
   $363.60), which is above the $950 `minimum_job_price`, so the floor never
   binds. The test is written against 12 LF, which does trigger it, and also
   asserts the 40 LF figure so the discrepancy stays recorded rather than being
   quietly papered over.

4. **13 of 39 pricing rows are `TBD-` placeholders and inactive** — every elbow,
   miter, end cap, hanger, strap, splash block, sealant and tear-off line. Until
   real yard codes and costs replace them, every estimate will show a populated
   "included in the work but not yet priced" section, and the quoted total will
   be materially lower than the real job cost. This is the single biggest
   accuracy gap in the tool.

## Decisions made

| Question | Decision |
|---|---|
| Gutter guard sizing | **Auto-match the gutter size.** A 5" gutter resolves the 5" cover, a 6" gutter the 6" cover. Both are $14.55/LF today, so this changes no number now, but the work order stays correct and the two can be priced apart later. The customer sees a single yes/no. |
| Lead capture | **No gate.** The total and the statement of work download are available to anyone. No third-party form endpoint, no dependency. The gate can be added later without touching the pricing engine. |
| Map tiles | **Esri World Imagery**, with the licensing caveat below accepted and revisitable. `TILE_PRIMARY` in `src/providers.js` is the one line to flip. |

Still needed from the owner (spec section 12):

- **Confirm `(747) 335-0597` is the number that should ring for gutter leads.**
  It is the main line from specialistroofing.com; the alt number there is
  `(626) 869-7663`.
- **Ten real past gutter jobs** — address plus the footage the crew actually
  ran — so the roof factors in the Rules tab get calibrated against reality
  instead of staying at the spec's guessed defaults.
- **Real yard codes and costs for the 13 `TBD-` rows** (see open item 4). This
  is the biggest single accuracy gap in the tool.

## Design

Matched to specialistroofing.com and the Specialist Roofing logo.

Palette, sampled from the live site's computed styles and the logo's pixels:

| Token | Value | Used for |
|---|---|---|
| `--blue` | `#003FBE` | logo mark, hero, headings, selected states |
| `--orange` | `#FF6B27` | logo underbar, every call to action, step chips |
| `--blue-deep` | `#071D47` | footer, the estimate total card |
| `--blue-bright` | `#204CE5` | hover |

Layout follows the live site: orange announcement bar, white sticky header with
the logo left and the phone right, a solid blue hero with an orange rule above
a heavy uppercase slab headline, then white cards, then a navy footer.

**Fonts are a substitution.** The live site sets headings in **Nexa Slab 900
uppercase** and UI text in **Nexa** — both licensed Fontfabric faces that cannot
be served from a free CDN, and licensing them would breach the zero-cost
constraint. This uses **Roboto Slab 900** and **Montserrat** from Google Fonts
as the closest free equivalents. If SRR already holds a Nexa webfont licence,
swap the two `--font-*` tokens in `assets/styles.css` and the `<link>` in
`index.html`; nothing else changes.

`assets/logo.png` is the supplied logo, used as-is. An SVG version would render
more crisply on high-DPI phones if one exists.

## The map and confirm step (phase 6)

`src/map.js` draws the footprint over Esri satellite imagery with Leaflet, both
from a CDN, no keys.

- **The module is optional by design.** If Leaflet fails to load, the CDN is
  blocked, or the tiles are down, `renderBuildingMap` returns null and the page
  says so in a line of text. The footage still comes from the OSM coordinates,
  so no estimate depends on the picture.
- **The chosen building is orange; the alternatives are dashed and tappable.**
  Tapping one swaps it in, recomputes the perimeter and corners from its own
  geometry, re-derives the footage, and relabels the result `confirmed by you`.
- **A blue dot marks where the address actually geocoded to**, which is usually
  the street frontage. Seeing the pin sitting off the building is the clearest
  possible explanation of why we are asking.
- The map frames the *chosen* building rather than every candidate - fitting
  them all zooms out far enough that nobody can recognise their own roof.
- Attribution for Esri and OpenStreetMap is rendered by Leaflet and is a licence
  condition, not a nicety.

### Roof picker, pulled forward from phase 5

A measured perimeter cannot become a footage without a roof factor, and the
swing is not small. On a 200 ft perimeter:

| Roof type | Factor | Gutter run | Price (aluminium K Style 5") |
|---|---|---|---|
| Gable | 0.62 | 128 ft | $3,050 |
| Flat | 0.95 | 194 ft | $4,600 |
| Hip | 1.00 | 204 ft | $4,775 |
| Not sure | 0.80 | 164 ft | $3,875 |

Shipping the map without the picker would have quoted gable jobs as if they
were hip jobs - a 57% error. So the picker landed here rather than in phase 5.

### Edits are never silently overwritten

Typing a figure into the linear feet field detaches it from the measurement and
marks it `customer supplied`. Changing the roof type, the material, or anything
else then leaves it alone, and a "Recalculate from the address" link appears to
reattach it. This is the part of spec 6.5 that could not be deferred without
the page being actively wrong.

## The editable chain (phase 5)

Spec 6.5 asks for a chain the customer can see and override at any step. All of
it is now live, and the arithmetic sits in one pure, tested function,
`deriveGutterRun()` in `src/geo.js`.

```
Building perimeter    200 ft   [editable]
Walls with gutter     3 of 4   [tick each wall]
Roof type             Gable    [picker, or superseded]
Gutter run            143 ft
```

### The modelling decision worth knowing about

The roof factor and the per-wall toggles answer the **same question** by
different means. `gutter_factor_gable` of 0.62 is an *estimate* that roughly two
of four sides are eaves. Ticking walls off is the customer stating it
*exactly*.

Applying both would subtract the same thing twice. A gable job with two of four
walls switched off would come out at 0.62 x 0.5 = **31% of perimeter instead of
50%** - roughly a third under, quoted far too cheap.

So the moment a wall is switched off, the customer's selection wins and the
roof factor stops applying. The chain shows a `NOT APPLIED` tag, the roof
picker greys out, and a line of copy explains why. There is a test named
*"switching walls off replaces the roof factor rather than stacking with it"*
that fails if anyone reintroduces the double count.

### What overrides what

| The customer... | Effect |
|---|---|
| Types a perimeter | Replaces the outline. Wall toggles are disabled (they no longer add up to it) and the roof factor still applies. A `reset` link restores the measured figure. |
| Switches walls off | Perimeter becomes the sum of the remaining walls, and the roof factor stops applying. |
| Types a linear feet figure | Detaches from the chain entirely, marked `customer supplied`. Nothing else overwrites it; a "Recalculate from the address" link reattaches it. |
| Picks a different building | Wall choices and perimeter edits are cleared, because they belonged to the old outline. |

### Method B, the square-footage fallback

For addresses OpenStreetMap has no outline for - new build, some multifamily
parcels, anything the bulk import missed. Offered automatically when a lookup
misses, and behind "Not my building" when it hits the wrong one.

```
footprint = total sq ft / stories
perimeter = 4 * sqrt(footprint) * footprint_shape_factor
```

2,400 sq ft over 2 storeys gives 155.19 ft of perimeter. It is labelled a
**rough estimate**, shows no map (there is no outline to show), offers no wall
list, and - importantly - the statement of work records the footage as
*"calculated from the home square footage and story count supplied by the
customer"* rather than claiming a building outline it never had.

## Known accuracy limits of the measurement

To be filled in as phase 4 lands. The short version, from the spec:

- The measurement comes from OpenStreetMap **vector building footprints**, not
  from the satellite picture. The imagery is cosmetic — it exists so the
  customer can confirm "yes, that is my house". If the imagery fails to load,
  the estimate still works.
- OSM footprint coverage in LA County is good because of a bulk import, but not
  universal. New construction and some multifamily parcels are missing; the
  square-footage fallback exists for those.
- A footprint polygon on an apartment building may cover the whole structure,
  including sections the customer does not own.
- OSM traces **walls, not eaves**, which is what `overhang_allowance_ft`
  compensates for.
- Attached garages, porches and additions may or may not be in the polygon.
- Gutter hangs on eaves, not rakes, so **gutter footage is not perimeter**. A
  gable roof gets gutter on roughly two of four sides.

None of this is fatal, because every number is editable and the site says so.

## Tile licensing — needs a decision

`src/providers.js` has `TILE_PRIMARY`, currently `'satellite'` (Esri World
Imagery). Esri's imagery is keyless and widely used, but their terms around
using ArcGIS Online tile layers outside a subscription are **not clearly
permissive for a commercial site**. The alternative is standard OSM tiles,
which are unambiguously free but are street maps, not aerial.

Flipping between them is a one-line change. This needs an explicit call rather
than a silent default.

## Third party etiquette

Overpass and Nominatim are volunteer funded. The site caches every response in
`localStorage` keyed by normalized address, sets a 15 second timeout, sends an
identifying `Referer`, geocodes only on submit (never per keystroke — that is
an explicit violation of Nominatim's policy), and falls through to the
square-footage method rather than retrying in a loop.

If this ever gets real traffic, the upgrade path is self-hosting Overpass, not
switching to a paid API.

Attribution for OpenStreetMap contributors and the imagery provider is a
licence condition, not a nicety.

## Out of scope for v1

Payments, scheduling, CRM writeback, multi-building properties, and anything
needing a server. A single `onEstimateComplete(result)` hook is the seam a
future integration subscribes to.
