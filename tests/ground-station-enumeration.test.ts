import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

/**
 * Tests the REAL groundProfile out of studio/main.ts, not a copy of it.
 *
 * Independent QA raised this directly: read-ground-interval.test.ts mirrors the
 * host arithmetic in its fake host, so it cannot catch a regression in the
 * studio's own station enumeration -- and it did not. F009 was found by a probe
 * that extracted the actual function through the TypeScript AST and ran it with
 * stubbed dependencies. That technique is adopted here so the suite owns the
 * boundary rather than a downstream tester.
 *
 * studio/main.ts is the app shell and has no other unit coverage: it is DOM glue
 * around tested modules. groundProfile is the exception -- real arithmetic that
 * happens to live there -- so it gets tested where it is.
 *
 * ⚠ If groundProfile gains a dependency, add it to the sandbox below. The same
 * applies to QA's own verify-ground-cap.cjs, which stubs the same four names.
 */

const CAP = 400;
const BEGIN = 1000;

function loadGroundProfile(): (design: unknown, intervalFt?: number) => { station: number }[] {
  const sourcePath = join(__dirname, "..", "studio", "main.ts");
  const source = readFileSync(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const decl = ast.statements.find(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === "groundProfile",
  );
  if (!decl) throw new Error("groundProfile declaration not found in studio/main.ts");
  const compiled = ts.transpileModule(decl.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const sandbox: Record<string, unknown> = {
    terrainSampler: {},
    computeHorizontal: (a: { fixtureLength: number }) => ({
      length: a.fixtureLength,
      pointAt: (d: number) => ({ n: 0, e: d }),
    }),
    computeVertical: () => ({ elevationAt: () => 100 }),
    sampleGround: (_s: unknown, pts: unknown) => pts,
  };
  createContext(sandbox);
  runInContext(compiled, sandbox, { timeout: 1000, filename: sourcePath });
  return (design, intervalFt) => {
    sandbox.__design = design;
    sandbox.__interval = intervalFt;
    return runInContext("groundProfile(__design, __interval)", sandbox, { timeout: 1000 }) as
      { station: number }[];
  };
}

const groundProfile = loadGroundProfile();
const sample = (lengthFt: number, intervalFt?: number): number[] =>
  groundProfile({ alignment: { beginStation: BEGIN, fixtureLength: lengthFt }, profile: {} },
    intervalFt).map((s) => s.station);

describe("ground sampling never exceeds the cap and always reaches the end", () => {
  // The threshold: floor(length / interval) === CAP - 1. Below it the endpoint
  // fits; at it, with a remainder, the appended endpoint used to make 401.
  const cases: { lengthFt: number; intervalFt: number; label: string }[] = [
    { lengthFt: 9950, intervalFt: 25, label: "below the threshold" },
    { lengthFt: 9975, intervalFt: 25, label: "exactly at the cap, no remainder" },
    { lengthFt: 9980, intervalFt: 25, label: "at the threshold WITH a remainder (F009)" },
    { lengthFt: 9999, intervalFt: 25, label: "at the threshold, large remainder (F009)" },
    { lengthFt: 10000, intervalFt: 25, label: "just past the threshold" },
    { lengthFt: 30000, intervalFt: 25, label: "far past the threshold" },
    { lengthFt: 3170, intervalFt: 100, label: "short road, partial last interval" },
    { lengthFt: 1500, intervalFt: 50, label: "the QA baseline road" },
  ];

  for (const c of cases) {
    it(`${c.lengthFt} ft at ${c.intervalFt} ft -- ${c.label}`, () => {
      const st = sample(c.lengthFt, c.intervalFt);

      expect(st.length).toBeLessThanOrEqual(CAP);
      expect(st.length).toBeGreaterThanOrEqual(2);
      // The end station is always sampled -- a cut/fill report that stops short
      // of the end of the road is silently incomplete.
      expect(st[st.length - 1]).toBeCloseTo(BEGIN + c.lengthFt, 6);
      expect(st[0]).toBeCloseTo(BEGIN, 6);
      // Monotonic, no duplicated station at the join.
      for (let i = 1; i < st.length; i += 1) expect(st[i]!).toBeGreaterThan(st[i - 1]!);
    });
  }

  it("keeps stations ON GRID whenever the cap does not force a widening", () => {
    // 3170 at 100 needs 33 stations, far inside the cap, so 10+00, 11+00, ...
    const st = sample(3170, 100);
    expect(st).toHaveLength(33);
    for (const s of st.slice(0, -1)) expect((s - BEGIN) % 100).toBeCloseTo(0, 6);
    expect(st[st.length - 1]! - st[st.length - 2]!).toBeCloseTo(70, 6);
  });

  it("keeps the grid at the cap when the road divides exactly", () => {
    const st = sample(9975, 25);
    expect(st).toHaveLength(400);
    expect(st[1]! - st[0]!).toBeCloseTo(25, 6);
    for (const s of st) expect((s - BEGIN) % 25).toBeCloseTo(0, 6);
  });

  it("widens uniformly rather than leaving a stub last interval", () => {
    // The F009 shape: 400 on-grid stations then a 401st five feet later.
    const st = sample(9980, 25);
    expect(st).toHaveLength(400);
    const first = st[1]! - st[0]!;
    const last = st[st.length - 1]! - st[st.length - 2]!;
    expect(first).toBeGreaterThan(25);
    expect(last).toBeCloseTo(first, 6);
  });

  it("defaults to 50 ft when no interval is passed", () => {
    const st = sample(1500);
    expect(st[1]! - st[0]!).toBeCloseTo(50, 6);
  });

  it("a widened step is always coarser than the request, never finer", () => {
    for (const len of [9980, 9999, 10000, 30000, 120000]) {
      const st = sample(len, 25);
      expect(st.length).toBeLessThanOrEqual(CAP);
      expect(st[1]! - st[0]!).toBeGreaterThanOrEqual(25 - 1e-9);
    }
  });

  it("holds the ceiling across a sweep of lengths around the threshold", () => {
    // The defect needed floor(length/interval) to land exactly on CAP-1 with a
    // remainder, which is why single spot checks at 30,000 ft missed it. Sweep it.
    for (let len = 9900; len <= 10100; len += 1) {
      const st = sample(len, 25);
      expect(st.length, `length ${len}`).toBeLessThanOrEqual(CAP);
      expect(st[st.length - 1]!, `length ${len}`).toBeCloseTo(BEGIN + len, 6);
    }
  });

  it("holds the ceiling for other intervals at their own thresholds", () => {
    for (const iv of [10, 20, 50, 100]) {
      for (let k = -3; k <= 3; k += 1) {
        const len = (CAP - 1) * iv + k * (iv / 4);
        if (len <= 0) continue;
        const st = sample(len, iv);
        expect(st.length, `interval ${iv}, length ${len}`).toBeLessThanOrEqual(CAP);
        expect(st[st.length - 1]!, `interval ${iv}, length ${len}`).toBeCloseTo(BEGIN + len, 6);
      }
    }
  });
});
