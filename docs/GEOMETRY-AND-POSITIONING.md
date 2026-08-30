# Geometry Completeness & Project Positioning

2026-06-11. Decisions from the coordinate-system / geometry-variables research session.

## Positioning: how GDOT projects are located (and what we implement)

**The decision chain in practice:** the survey topo (SURVRD per GDOT EDG) is delivered
ON project control — Georgia State Plane grid, specific zone, NAVD88 elevations.
Designers clean the topo, then every design file references it and inherits its basis.
Positioning is decided once, by survey control — never per-file. Sealed evidence:
PI 762380 cover — "prepared using the Georgia Coordinate System of 1985 West Zone and
the North American Vertical Datum of 1988."

**Our implementation (schema v0.2, shipped):**
- `RoadDesign.crs` block: zone, `epsgCode`, horizontal/vertical datums,
  `coordinateBasis: "grid" | "ground"`, optional `combinedScaleFactor` (required by
  zod when basis is ground), optional `geoid`.
- Canonical Georgia values: **GA West = EPSG:2240**, **GA East = EPSG:2239**
  (both NAD83, US survey foot). Vertical: **NAVD88**.
- LandXML exporter emits `<CoordinateSystem desc="..." epsgCode="...">` (positioned
  Units → CoordinateSystem → Project per the schema sequence) — ORD and Civil 3D read
  this for georeferencing.
- Studio: coordinate-system + basis selectors; GA West grid is the default.

**Grid vs ground (the classic import bug):** state plane coordinates are grid;
taped ground distances differ by the combined scale factor (CSF = grid scale factor ×
elevation factor). Files that don't declare their basis cause silent misposition/scale
errors. Our schema REQUIRES declaring it, and requires the CSF when ground.

**Topo workflow fit (input pipe, future):** when terrain import lands, the imported
LandXML's CoordinateSystem must match the project's `crs` — mismatch is a validation
error, not a silent reproject. Reprojection is out of scope until much later; we
position by matching the survey's CRS, exactly as designers do.

## Horizontal geometry — variable completeness matrix

| Variable | Status | Notes / plan |
|---|---|---|
| Tangents (length, bearing) | ✅ | dir attrs exported |
| Circular arcs: R, Δ, direction | ✅ | T, L, E, M, chord computed; D (arc def) derivable = 5729.57795/R |
| PC/PT/PI stations + coordinates | ✅ | element report + LandXML PI points |
| Deflection angle points (<10°) | ✅ | plan-driven (PI 0000297 sheet 47) |
| **Spiral transitions (clothoid)** | ⬜ deferred, spec'd | needed for high-speed mainlines; entry/exit spiral Ls, TS/SC/CS/ST points, θs = Ls/(2R). Checker flags speeds where GDOT practice expects spirals. LandXML `<Spiral>` exists. RoadBench will force this when we encode an interstate mainline. |
| **Station equations** (back/ahead) | ⬜ deferred, spec'd | schema element `{type:"stationEquation", backStation, aheadStation}`; kernel keeps true distance, labels remap. Common on real projects (overlap stationing on SR 3 corpus). |
| PI-based authoring (PI coords + R) | ⬜ | input convenience — derives element list; kernel unchanged. Natural fit for the AI assistant + plan ingestion. |
| Curve definition by D (degree of curve) | ⬜ | display + input alternative; arc definition (GDOT): R = 5729.57795/D |
| Bearings as quadrant N/S E/W | ⬜ | display formatting; azimuth is canonical internally |

## Vertical geometry — variable completeness matrix

| Variable | Status | Notes / plan |
|---|---|---|
| PVIs, grades, grade breaks | ✅ | |
| Symmetric parabolic VC (L) | ✅ | validated vs sealed VC430/VC200 (RoadBench #2) |
| K = L/A, high/low points | ✅ | validated vs sealed plans |
| PVC/PVT stations + elevations | ✅ | |
| **Unsymmetrical vertical curves** (L1 ≠ L2) | ⬜ deferred | two-parabola formulation; rare but present on constrained urban profiles |
| Design speed → K criteria check | ⬜ M4 | criteria pack (GDOT DPM tables as data) |
| Vertical exported in LandXML ProfAlign | ✅ | PVI + ParaCurve |

## Sources
- GDOT Automated Survey Manual (Rev 11.1): https://www.dot.ga.gov/PartnerSmart/DesignManuals/SurveyManual/SurveyManual.pdf
- EPSG 2240 (GA West ftUS): https://epsg.io/2240 · EPSG 2239 (GA East ftUS): https://epsg.io/2239
- Grid/ground & CSF: https://rashms.com/gis/grid-coordinate-ground-coordinate-distance-combined-scale-factor/
- FHWA PDDM Ch.5 Surveying & Mapping: https://highways.dot.gov/federal-lands/pddm/Chapter_05.pdf
- LandXML CoordinateSystem usage (epsgCode attr): Autodesk/Bentley community examples
- Spiral practice & station equations: WyDOT Road Design Manual 3-02, MoDOT EPG 230.1,
  MDT RDM Ch.3 + Appendix H
- Sealed evidence: PI 762380 cover sheet (GCS-85 West + NAVD88), corpus READMEs.
