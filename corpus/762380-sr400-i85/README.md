# RoadBench corpus entry: PI 762380 — SR 400 / I-85 Connector Ramps (as-built)

Source: GDOT Design Plans Library (public), sealed as-built plans completed 04-17-2015.
Project NH000-0085-02(153), Fulton/DeKalb counties. Design speed 45 mph.
Sheets were downloaded from the library and held locally; they are not redistributed
here. Fetch them from the URL pattern below.
URL pattern: `https://mydocs.dot.ga.gov/info/designplans10/DesignPlansLibrary/762380_{sheet:7d}_AB.PDF`

## Extracted printed values (alignment "℄ RAMP STRIPING", SR 400 SB → I-85 NB)

Sheet 18 (dwg 13-00A):
- BEGIN ALIGNMENT STA 590+50.00, N=1,393,656.43 E=2,237,764.39, bearing S 9°20'23.5" W
- PC 591+13.18 (curve 501)

Sheet 19 (dwg 13-00B):
- Curve #501: PI Sta 594+08.51, N=1,393,301.79 E=2,237,706.07,
  DELTA=7°50'10.1" (LT), D=1°19'43.5", T=295.33, L=589.74, R=4312.00, E=10.10
- Curve #502: PI Sta 599+54.85, N=1,392,754.72 E=2,237,691.71,
  DELTA=5°14'26.1" (LT), D=1°16'49.27", T=204.80, L=409.31, R=4475.00, E=4.68
- PT 597+02.92 (curve 501), PC 597+50.05 (curve 502)

## Cross-checks encoded as golden tests

- PC(501) = PI − T = 59408.51 − 295.33 = 59113.18 ✓ (matches sheet 18 label)
- PT(501) = PC + L = 59113.18 + 589.74 = 59702.92 ✓ (matches sheet 19 label)
- PC(502) = PI(502) − T(502) = 59954.85 − 204.80 = 59750.05 ✓
- Entry tangent = PC(501) − begin = 63.18 ft; intermediate tangent = PC(502) − PT(501) = 47.13 ft
- Printed values are rounded to 0.01 ft / 0.1 arc-second → test tolerance ±0.005-0.01 ft.
