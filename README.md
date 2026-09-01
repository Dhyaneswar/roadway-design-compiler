# Roadway Design Compiler

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-485%20passing-brightgreen.svg)](tests)
[![WebMCP tools](https://img.shields.io/badge/WebMCP-39%20tools-8a2be2.svg)](#what-the-agent-can-do)

**An agent-native roadway design tool. The agent does the engineering. It cannot sign for it.**

Live: **https://roadway-design-compiler.gandidhyaneswar.workers.dev**

Built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

## Prior work and work added during the Submission Period

This is a **pre-existing project meaningfully extended with WebMCP** during the
Submission Period (25 August – 3 September 2026). Everything agent-facing was built
inside that window. Stated plainly so it can be checked rather than taken on trust.

**Existed before the Submission Period.** A deterministic roadway geometry kernel and
the deliverable it produces — horizontal and vertical alignment, corridor sweep,
template sections, design criteria, superelevation; the `RoadDesign` schema and its
validation; the LandXML exporter; a form-driven Studio; and the RoadBench golden tests
that reproduce two sealed GDOT projects. Its own record is in this repository and is
dated: [`corpus/s1-spike-log.md`](corpus/s1-spike-log.md) documents the OpenRoads
round-trip on 2026-06-11, and
[`docs/GEOMETRY-AND-POSITIONING.md`](docs/GEOMETRY-AND-POSITIONING.md) carries the same
date. At that point the project had no agent surface of any kind.

**Added during the Submission Period.** The entire agent-facing half:

- all **39 WebMCP tools** and the bridge that registers them, the typed refusals that
  carry the numbers needed to resolve them, and the annotation policy;
- the **agent-proposed change ledger** and the human confirmation gate — the boundary
  this project exists to test, including the deliberate absence of any tool that clears it;
- the agent activity log, design alternatives, and the portable design document that
  carries a design, and its unconfirmed provenance, in a link;
- LandXML **import** — alignments, TIN terrain, as-designed sections, survey plan
  features — plus roadside furniture, the construction staking export, the coordinate
  system module, the authored pavement structure, and surface appearance;
- the 3D corridor view's ground, reference-surface and pavement rendering.

**The evidence is the commit history.** The first published commit (30 August) bundles
the pre-existing modules together with the first WebMCP layer; every commit after it is
in-window work, visible one at a time. 49 of the repository's 112 files were added after
that first commit, among them 18 test files and 17 driver scripts, 12 of which are
end-to-end verification harnesses that drive the built app over CDP exactly as an agent
would.

Per the challenge rules, **only the work added during the Submission Period is offered
for evaluation.** The kernel beneath it is prior work, and is included because the agent
surface is meaningless without something real underneath it to be honest about.

---

## The idea

A roadway design is sealed by a licensed Professional Engineer who carries personal
legal liability for it. That signature cannot be delegated to software, and it
certainly cannot be delegated to an agent.

So the interesting question WebMCP raises for regulated work is not *"how much can
the agent do?"* — it is:

> **How does a site expose tools so an agent can do real work right up to, but never
> past, the line where a licensed human must sign?**

This app draws that line and enforces it:

- An agent can design an entire road — geometry, vertical profile, cross sections,
  superelevation — through 39 WebMCP tools.
- Every change it applies is stamped **agent-proposed** and held for confirmation.
- **The LandXML deliverable is refused while anything is unconfirmed**, and there is
  deliberately **no tool that clears that**. Confirmation happens in the UI, by a person.

The same boundary exists in medicine, law, structural engineering, financial audit,
aviation maintenance — anywhere a licensed human signs and is liable. WebMCP is the
first place that boundary can be declared *by the site, in the tool definition*,
instead of hoped for in a system prompt.

## What the agent can do

| | tools |
|---|---|
| **Read** | the design, alignment extents, curve table, profile table, a cross section at any station, superelevation transitions, unconfirmed changes, and `what_do_i_need` |
| **Offer** | `propose_alternatives` — two to four complete designs, each costed and judged, for the engineer to choose between |
| **Judge** | `check_design_criteria` — every curve, K value and grade against a design speed |
| **Propose** | `propose_full_design` — a whole road from a description |
| **Edit** | project setup, horizontal elements, PVIs, template segments and drops, superelevation |
| **Undo** | `undo_last_change` — reverts the agent's own unconfirmed work, and refuses once a human has confirmed it |
| **Deliver** | `export_landxml` and `export_staking_csv` — both gated on human confirmation |
| **Ingest** | `import_landxml` — an alignment somebody else drew, the ground it runs over, and the sections its designer produced |
| **Reference** | `read_design_sections` — the original designer's pavement structure, held apart from your own |
| **Context** | `read_site_features` — the existing site: buildings, kerbs, sidewalks, lot lines |
| **Ground** | `read_ground` / `read_terrain_extent` — cut and fill against a surveyed surface |
| **Dress** | `set_segment_material` and `place_roadside_item` — what the road is made of, and the guardrail, barrier, curb and markings on it |
| **Hand off** | `read_design_document` / `load_design_document` — the whole design in a link |
| **Structure** | `set_pavement_layers` / `read_pavement_layers` — the pavement courses an engineer states, recorded at their exact authored thickness and drawn under the road. ⛔ Authored, never designed: no default stack, no thickness suggested, and no adequacy calculated |
| **Georeference** | `set_coordinate_system` / `read_coordinate_systems` — what places the LandXML in the world |

Three things are deliberate:

1. **Preview is the default.** Every write tool computes the consequence and changes
   nothing unless you pass `commit: true`.
2. **A refusal is a result, never an exception** — and it carries the numbers needed
   to fix it plus the tool that fixes it. An agent that is refused is not stuck; it is
   told what to do next.
3. **Everything the agent can do, a human can do.** Superelevation, criteria, geometry
   — all authorable in the UI. An agent must never become a gatekeeper on an
   engineering decision.

### The refusal loop, which is the whole point

```
agent: set PVI 2 vertical curve to 3000 ft
  → REFUSED  VerticalCurvesOverlap
             { curveLengthFt: 800, overlapFt: 200, previousPvtStationFt: … }
             resolvedBy: ["set_pvi"]
agent: (computes 800 − 2×200 − margin = 380) set PVI 2 curve length 380 ft
  → committed. K = 95.0
```

The agent is doing engineering arithmetic driven by a structured refusal. Nothing
about that exchange is scripted.


### Options, not answers

A designer rarely wants *the* answer; they want two or three defensible options
with the trade-offs computed. `propose_alternatives` lets an agent offer complete
designs side by side — length, tightest radius, lowest K, and every criteria
failure with the number that would fix it:

```
tight     2706.9 ft   min R  900   min K 181.00   2 of 4 FAIL
          curve 2 radius 900 ft is 458.23 ft BELOW the 1358.23 ft minimum for 60 mph
balanced  3413.7 ft   min R 1800   min K 214.57   1 of 4 FAIL
gentle    4513.3 ft   min R 3200   min K 248.21   1 of 4 FAIL
```

⛔ **Nothing is applied, and there is no tool that adopts one.** Ranking these needs
judgement about site, budget and right-of-way that a model does not have. A person
clicks the option they want.


### Handing the design to the engineer who signs

The premise only works if the design can reach the person who has to seal it. So a
design **saves itself** — reload and it is still there — and packs into a link:

```
https://…/#design=eyJ2ZXJzaW9uIjoxLCJzYXZlZEF0Ijoi…
```

About 1.3 KB for a typical road. Everything after `#` stays in the browser and is
**never sent to a server**, so a design in a link is not logged by anyone's
infrastructure on the way. No account, no upload, no backend. Open the link in a
different browser and you get exactly the design that was sent.


### Reading a road somebody else drew

Export was a one-way door, which capped this at greenfield work — every practising
engineer already has alignments. `import_landxml` reads them.

Three decisions, each made the robust way:

- **Geometry comes from the coordinates, not from `dir`.** Measured against a real
  public file, `dir="2.238999"` is *radians*; other writers emit degrees, and the
  Units block does not always say which. Start/End/Center points are unambiguous.
- **An unsupported element is a refusal, never an approximation.** Spirals appear in
  3 of the 5 real alignments tested here. This kernel does not model them, so such a
  file is refused *with the count* — quietly dropping a spiral changes the geometry
  of a road somebody is going to build.
- **The expensive files are refused before a DOM is built.** Two OpenRoads exports
  here are 19.7 MB and 31.1 MB — 504,000 and 822,000 elements of TIN surface, with no
  alignment at all. A substring pre-scan answers that in milliseconds instead of
  taking the tab down.

Run it against your own files:

```bash
npx tsx scripts/try-import.mjs <file-or-directory>
```

Against the 12 public samples available here: **2 imported, 10 refused, every refusal
naming its reason.**


### The road on the ground

A design surface floating in space is a drawing. Tied to ground it becomes
engineering. `import_landxml` reads the TIN surface out of the same file as the
alignment, draws it under the road in 3D, and `read_ground` reports what it costs:

```
surface "Landscape_road": 15,067 triangles, 7,664 points
131 stations · max cut 18.35 ft · max fill 7.11 ft · 9 balance points
  sta      0   ground  72.89   design  74.53   FILL 1.64 ft
  sta    100   ground  75.93   design  74.06   CUT  1.86 ft
```

Sign convention, stated because getting it backwards inverts an estimate:
**positive is fill**, the road above ground; **negative is cut**, below it.

⛔ A station that falls outside the surveyed surface reports **no ground**, not a
guess. A road can run past the edge of a survey, and inventing ground there is how
a design gets built wrong.

Sampling is indexed rather than scanned — a uniform grid over the triangles, built
in 6 ms for 15,067 faces, so a mile of road samples in under a millisecond instead
of running hundreds of millions of point-in-triangle tests.


### Authored, not decorated

The 3D view draws asphalt as asphalt and gravel as gravel, puts an edge line where
pavement meets something that is not, and stands a guardrail up where one was
placed. None of it is inferred.

⛔ **Material is never guessed from a segment's name.** A shoulder is asphalt on one
project and gravel on the next; a segment with no stated material is drawn neutrally
rather than characterised.

⛔ **Roadside furniture is never placed by the tool.** LandXML carries no guardrail,
so it would have been easy to conclude that drawing one is always invention. That is
the wrong line — the distinction is **authored versus invented**, not existing versus
new. A guardrail an engineer placed from 20+00 to 34+00, left side, 20 ft offset is
design data, and a tool that cannot author it is not a design tool.

What it still refuses to do is decide whether a guardrail is **warranted** — that
depends on fill height, side slope and clear zone, and is the judgement a licensed
engineer is paid to make:

```
place_roadside_item  gr-left-1   guardrail left 2000-3400 at 20 ft   -> 1400 ft
                     off the end of the alignment  -> RoadsideOutsideAlignment
                     a signed offset               -> RoadsideOffsetNotPositive
                     a marking with no pattern     -> MarkingPatternUnstated

read_roadside        guardrail          1 item   1400 ft
                     concrete-barrier   1 item   1000 ft
                     pavement-marking   1 item   5225 ft
```

That last block is a quantity take-off — count and length by kind, which is what
goes on a bid schedule.


### The original designer's pavement

A LandXML out of real design software often carries the sections its designer
actually produced — not a template to sweep, but finished surfaces station by
station. `import_landxml` reads them and holds them as **reference**, drawn
translucent so they can never be mistaken for the corridor this app sweeps:

```
surface        stations    width(ft)   roadway?
Teoretisk           221      38.553    YES - pavement
Slitlager           221      38.553    YES - pavement     (the wearing course)
Terrace             221      135.13    YES - pavement
Berg                220    5591.528    no  - ground
Jord                221   10208.404    no  - ground
```

⭐ **That classification is a width test, not a reading of the names** — which are
Swedish on this file, and will be something else on the next one.

⛔ They are deliberately not merged into the design. Merging would quietly replace
the engineer's model with somebody else's and make the two impossible to tell apart.


### The site that is already there

A survey LandXML carries what exists. `import_landxml` reads it and draws it as
context, so a new alignment can be placed in a real site rather than in space:

```
71 features · 547 points · 0 unresolved references
site extent  N 4844..5566   E 4975..6125 ft
  EP (edge of pavement) · SDWK (sidewalk) · SHD (shoulder)
  BLDG (building) · LOT · TC (top of curb)
```

⚠ **Most survey geometry is written as point REFERENCES, not coordinates** — 1,470
`pntRef` against 72 inline pairs on the file this was measured against. A reader
handling only inline coordinates would import 5% of the site and look like it
worked, which is worse than importing none.

⛔ Feature names are carried exactly as written and never interpreted. `BLDG1|1094`
is a building on this survey and could be anything on the next; the grouping in the
summary is a label taken from the file's own separator, not a classification.

## Design criteria without redistributing a standard

Minimum-radius and K-value tables live in the AASHTO Green Book, a copyrighted
commercial publication. **Nothing is transcribed here.** Every criterion is computed
from the governing relationship —

```
R    = V² / (15(e + f))               minimum radius
SSD  = 1.47·V·t + V² / (30·(a/32.2))  stopping sight distance
K    = S² / (100(√h₁ + √h₂)²)         crest
K    = S² / (400 + 3.5·S)             sag (headlight)
e    = V² / (15R) − f                 superelevation rate
Lr   = (w·n·e) / Δ · bw               superelevation runoff
```

— and every coefficient those need (side friction, reaction time, deceleration, eye
and object heights, maximum relative gradient, maximum grade) is an **input with a
documented default**. An agency that adopts different values supplies its own and
gets its own answers. Every verdict reports the basis it used.

⚠ The defaults are illustrative, **not an adopted agency standard**.

## Running it

```bash
npm install
npm test               # 485 tests
npm run studio         # http://localhost:5173
npx vite build studio  # production build → studio/dist
```

**To drive it with an agent**, open it in ChatGPT's in-app browser, or in Chrome with
`chrome://flags/#enable-webmcp-testing` enabled. The page tells you which of those
you are in.

**How to tell the agent really used WebMCP:** the page keeps a live *Agent activity*
log, written from inside `executeTool`. Browser control can change the form all day
and that log stays empty. If it fills, your agent used the tool surface.

### Verification harnesses

Driver-owned, run against the built app over CDP exactly as an agent would:

```bash
node scripts/verify-webmcp.mjs          # tools, preview-does-not-mutate, refusal→solve→commit
node scripts/verify-superelevation.mjs  # banking reaches the cross sections and the 3D view
node scripts/verify-seal.mjs            # export refused until a human confirms
node scripts/verify-parity.mjs          # a human can author everything an agent can
node scripts/verify-new-tools.mjs       # undo, alternatives, and the staking gate
node scripts/verify-handoff.mjs         # survives reload; a link opens in a SECOND browser
node scripts/verify-import-live.mjs     # an agent imports a real third-party LandXML
node scripts/verify-terrain.mjs         # ground imported, drawn, and cut/fill computed
node scripts/verify-roadside.mjs        # materials, furniture, refusals, quantities
node scripts/verify-design-sections.mjs # the designer's own sections, read and drawn
node scripts/verify-live.mjs            # the whole story against the deployed URL
node scripts/rehearse-video.mjs         # walks the demo beat by beat, screenshots each
```

## Architecture

```
src/schema/      RoadDesign document + zod validation (cross-field rules live here)
src/kernel/      horizontal · vertical · corridor · template-section · criteria ·
                 superelevation · terrain — pure, deterministic, golden-tested
src/importers/   LandXML 1.1 / 1.2 reader — alignments, TIN surfaces, as-designed sections
src/exporters/   LandXML 1.2 (ORD-hardened) and construction staking CSV
src/studio/      WebMCP bridge · typed refusals · agent change ledger · activity log ·
                 design alternatives · portable design document
studio/          the app: form, live tables, SVG plan+profile, 3D corridor (three.js)
```

No model sits in the authoritative path. The agent chooses *what to ask*; the kernel
decides *what is true*.

## Field result

The LandXML exporter has been round-tripped into a production OpenRoads Designer
installation as a native alignment and profile, and Bentley's own annotation
reproduced the curve table to 0.01 ft. See `corpus/s1-spike-log.md`.

## Status and limits

- Conceptual design tooling. **Not for construction.** Every design requires review
  and sealing by a licensed Professional Engineer.
- Earthwork is reported as cut and fill depth per station, not as volumes. Volumes need
  end-area computation across the full template, which this does not do yet.
- The criteria defaults are illustrative, not an adopted standard.

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
