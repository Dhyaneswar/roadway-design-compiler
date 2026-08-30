# Roadway Design Compiler

**An agent-native roadway design tool. The agent does the engineering. It cannot sign for it.**

Live: **https://roadway-design-compiler.gandidhyaneswar.workers.dev**

Built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

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
  superelevation — through 21 WebMCP tools.
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
| **Judge** | `check_design_criteria` — every curve, K value and grade against a design speed |
| **Propose** | `propose_full_design` — a whole road from a description |
| **Edit** | project setup, horizontal elements, PVIs, template segments and drops, superelevation |
| **Deliver** | `export_landxml` — gated on human confirmation |

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
npm test               # 209 tests
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
node scripts/verify-live.mjs            # the whole story against the deployed URL
```

## Architecture

```
src/schema/      RoadDesign document + zod validation (cross-field rules live here)
src/kernel/      horizontal · vertical · corridor · template-section · criteria ·
                 superelevation — pure, deterministic, golden-tested
src/exporters/   LandXML 1.2, ORD-hardened
src/studio/      WebMCP bridge · typed refusals · agent change ledger · activity log
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
- No existing-ground surface, so no cut/fill or earthwork quantities. The corridor is
  a design surface, not a tie to ground.
- The criteria defaults are illustrative, not an adopted standard.

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
