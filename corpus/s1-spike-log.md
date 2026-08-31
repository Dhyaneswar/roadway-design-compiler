# S1 Spike Log — LandXML → ORD import

## Attempt 1 — 2026-06-11 (FAIL, wrong import tool)
- Evidence: two photos (T:\search WhatsApp images, 5:21 PM).
- Used: **Survey workflow → Import → File** on `rdc-s1-sample.xml` → ORD error
  "Error occurred importing File: Land XML File".
- Diagnosis: Survey's File import expects field books / survey points
  (<Survey>/<CgPoints> content). Our file is design geometry (Alignment +
  Profile) — wrong importer, not (necessarily) a wrong file.
- File validation: `RDC-S1-SAMPLE.xml` passes the official LandXML 1.2 XSD
  (validated 2026-06-11 with xmlschema against landxml.org schema). 
- Environment note: the import was run inside a licensed OpenRoads Designer
  installation rather than a sandbox, which is what makes this a field result and
  not a lab one.

## Attempt 2 — retry script (the correct door)
1. Open a roadway DESIGN file (not a survey fieldbook dgn) — any scratch design
   file with a Georgia state-plane seed is fine.
2. Top-left workflow dropdown: switch **Survey → OpenRoads Modeling**.
3. Ribbon: **Geometry tab → General Tools → Import/Export → Import Geometry**.
4. Pick `RDC-S1-SAMPLE.xml`. A tree dialog appears: expand **Alignments**,
   check **RDC-S1-SAMPLE** (tick "Create Civil Rules" if offered; also tick the
   profile if shown as a child).
5. Fit view (it lands near E 2,200,000 / N 1,350,000 — GA-plausible coords).
6. Pass criteria: alignment appears in Explorer → OpenRoads Model → Alignments
   as a named, clickable element; stationing starts 10+00; profile opens in a
   profile view; units/coordinates sane.
7. Screenshot whatever happens — pass or fail, it's signal.

Secondary check while there (30s): does **Terrain → Export to LandXML** exist
on a terrain from any project? (That's S2's mechanism.)

## Attempt 2 — 2026-06-11 (PARTIAL: right dialog, file classified as survey)
- Evidence: photo of Import Geometry dialog showing only "Field Book 1" node —
  no Alignments group. ORD parsed our v1 file as survey content.
- Root cause (diff vs known-good Autodesk sample `out/sample-simple-road.xml`):
  our file lacked `angularUnit`/`directionUnit` in Units, a `<Project>` element,
  `dir` attributes on Lines, and `crvType`/`dirStart`/`dirEnd`/`<PI>` on Curves.
- Fix shipped: exporter hardened (TDD, commit 3c5249e); sample regenerated and
  re-validated against the LandXML 1.2 XSD.

## Attempt 3 — 2026-06-11 (RECOGNIZED — v2 file parses as Alignment + Profile)
- Evidence: photo of Import Geometry dialog showing the full tree:
  RDC-S1-SAMPLE → Alignment → NoFeature → RDC-S1-SAMPLE → Profile →
  RDC-S1-SAMPLE-profile, all checked. Feature definitions auto-assigned from
  the firm workspace table (MAIN_P_CONSTCL_100); Create Civil Rules on.
- The v1→v2 exporter hardening (dir attrs, PI points, angular/direction units,
  Project element) was exactly the fix. ORD-compat requirements now encoded as
  exporter tests.

## Attempt 4 — 2026-06-11 evening: **S1 PASSED** ✅
Evidence: two photos (6:33-6:34 PM).
1. Plan view: RDC-S1-SAMPLE imported as a Complex Element (status bar confirms),
   station ticks annotated via Element Annotation, full S-curve geometry visible.
2. Profile view "View 2, Profile - RDC-S1-SAMPLE": designed crest+sag profile
   rendering against station/elevation grid.
3. **Cross-validation by Bentley's engine:** ORD's element annotation generated
   a curve table from our geometry — PI 47+14.00, N 1,349,492.7830,
   E 2,203,454.2615, Δ 30°00'00.0" (LT), D 02°51'53.24", T 535.90',
   L 1047.20', R 2000.00', E 70.55' — every value matches our kernel to 0.01
   (PI station = PC₂ 41+78.10 + T 535.90 = 47+14.00 exactly).

**Conclusion: the output pipe (kernel → LandXML → ORD native civil objects) is
proven end-to-end, with independent confirmation of our geometry by Bentley's
own calculator. Wedge A's technical premise is validated in the field.**

Residual S1 notes: superelevation field shows ed 0.0% and D.S. blank (we don't
emit design speed metadata yet — candidate exporter enhancement: Alignment
`desc`/DesignSpeed). Curve# label blank (cosmetic).
