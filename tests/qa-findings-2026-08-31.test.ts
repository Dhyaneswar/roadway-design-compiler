// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";
import type { ProjectCrs } from "../src/schema/road-design";
import { projectCrsFor } from "../src/studio/crs";

/**
 * Regressions for the independent WebMCP QA pass of 2026-08-31.
 *
 *   F002  set_pvi accepted a station for the FIRST or LAST PVI, reported
 *         committed:true, and left the saved endpoint where it was. Those
 *         stations are derived from the alignment; a no-op is not a commit.
 *   F003  read_superelevation declared atStation, documented it as "the cross
 *         slope of each side at any station you ask about", and took no args at
 *         all -- so station 0 and station 750 returned identical objects while
 *         read_cross_section independently showed the section banking.
 *   F005  The agent's staking CSV said "CRS not set" while the Studio's own
 *         download of the SAME export carried EPSG:2240, because the human path
 *         passed the CRS and the tool path did not.
 *   F008  lengthBytes was String.length -- UTF-16 code units, not bytes.
 */

const GA_WEST: ProjectCrs = {
  zone: "GA-West",
  epsgCode: 2240,
  horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, West Zone",
  verticalDatum: "NAVD88",
  coordinateBasis: "grid",
};

// 500 ft tangent, a 1500 ft radius 30 degree curve, 500 ft tangent.
// Length = 500 + 1500*30*PI/180 + 500 = 1785.3982 ft, so the road runs
// 1000.0000 to 2785.3982.
const END_STATION = 1000 + 500 + (1500 * 30 * Math.PI) / 180 + 500;

const seed = (): StudioForm => ({
  name: "QA Fixture",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "500" },
    { kind: "arc", radius: "1500", deltaDeg: "30", direction: "right" },
    { kind: "tangent", length: "500" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "1800", elevation: "862", curveLength: "400" },
    { station: String(END_STATION), elevation: "870" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
  superelevation: { designSpeedMph: 60, emax: 0.06, normalCrownPercent: 2 },
  // The CRS rides the FORM now (F004), not a separate host getter.
  crs: { zone: "GA-West", basis: "grid" },
});

// ⚠ null, not undefined: passing undefined to a defaulted parameter selects the
// DEFAULT, so makeHost(undefined) quietly tested the GA-West arm twice.
function makeHost(crs: ProjectCrs | null = GA_WEST) {
  let form = seed();
  if (crs === null) delete (form as { crs?: unknown }).crs;
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(form)) as StudioForm,
    writeForm: (next) => { form = JSON.parse(JSON.stringify(next)) as StudioForm; },
    pendingChanges: () => [],
    undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" }),
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [{ value: "GA-West", label: "Georgia West" }],
    readCrs: () => projectCrsFor(form.crs),
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => undefined,
    setTerrain: () => {},
    groundProfile: () => undefined,
  };
  return { host, form: () => form };
}

function makeHostWithoutSuper() {
  let form = seed();
  delete (form as { superelevation?: unknown }).superelevation;
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(form)) as StudioForm,
    writeForm: (next) => { form = JSON.parse(JSON.stringify(next)) as StudioForm; },
    pendingChanges: () => [],
    undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" }),
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [{ value: "GA-West", label: "Georgia West" }],
    readCrs: () => projectCrsFor(form.crs),
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => undefined,
    setTerrain: () => {},
    groundProfile: () => undefined,
  };
  return { host };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

describe("F002 -- a derived endpoint station is refused, not silently normalised", () => {
  it("refuses a conflicting LAST PVI station and names the derived value", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pvi", { index: 3, stationFt: 1490, commit: true });

    expect(r.committed).toBeUndefined();
    expect(r.code).toBe("DerivedStationNotSettable");
    const m = r.measurements as Record<string, number>;
    expect(m.requestedStationFt).toBe(1490);
    expect(m.derivedStationFt).toBeCloseTo(END_STATION, 3);
    // And it points at what would actually move it.
    expect(r.resolvedBy).toContain("set_horizontal_element");
  });

  it("refuses a conflicting FIRST PVI station and points at project setup", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pvi", { index: 1, stationFt: 900, commit: true });
    expect(r.code).toBe("DerivedStationNotSettable");
    expect(r.resolvedBy).toContain("set_project_setup");
  });

  it("changes nothing when it refuses", async () => {
    const h = makeHost();
    const before = JSON.stringify(h.form());
    await call(h.host, "set_pvi", { index: 3, stationFt: 1490, commit: true });
    expect(JSON.stringify(h.form())).toBe(before);
  });

  it("still allows the endpoint ELEVATION to be set", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pvi", { index: 3, elevationFt: 875, commit: true });
    expect(r.committed).toBe(true);
    expect(h.form().pvis[2]!.elevation).toBe("875");
  });

  it("accepts the derived station passed back redundantly", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pvi",
      { index: 3, stationFt: END_STATION, elevationFt: 872, commit: true });
    expect(r.committed).toBe(true);
  });

  it("leaves interior PVI stations settable", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pvi", { index: 2, stationFt: 1750, commit: true });
    expect(r.committed).toBe(true);
    expect(h.form().pvis[1]!.station).toBe("1750");
  });
});

describe("F003 -- read_superelevation answers the station it was asked about", () => {
  it("returns different cross slopes at different stations", async () => {
    const h = makeHost();
    const a = await call(h.host, "read_superelevation", { atStation: 1000 });
    const b = await call(h.host, "read_superelevation", { atStation: 1600 });

    expect(a.atStation).toBeDefined();
    expect(b.atStation).toBeDefined();
    expect(JSON.stringify(a.atStation)).not.toBe(JSON.stringify(b.atStation));
  });

  it("reports normal crown at the start of the road", async () => {
    const h = makeHost();
    const r = await call(h.host, "read_superelevation", { atStation: 1000 });
    const at = r.atStation as { phase: string; leftPercent: number; rightPercent: number };
    expect(at.phase).toBe("normal-crown");
    expect(at.leftPercent).toBe(-2);
    expect(at.rightPercent).toBe(-2);
  });

  it("reports full superelevation inside the curve, banked one way", async () => {
    // The curve runs 1500 to 2285.4; mid-curve must be fully banked.
    const h = makeHost();
    const r = await call(h.host, "read_superelevation", { atStation: 1890 });
    const at = r.atStation as { phase: string; leftPercent: number; rightPercent: number };
    expect(at.phase).toBe("full-superelevation");
    // A banked section is not a crown: the two sides no longer match.
    expect(at.leftPercent).not.toBeCloseTo(at.rightPercent, 6);
  });

  it("refuses a station off the end of the alignment", async () => {
    const h = makeHost();
    const r = await call(h.host, "read_superelevation", { atStation: 9000 });
    expect(r.code).toBe("StationOutsideAlignment");
    expect((r.measurements as Record<string, number>).requestedStationFt).toBe(9000);
  });

  it("says the policy is off rather than inventing slopes for a station", async () => {
    // QA asked for disabled-policy coverage: with no policy there is nothing to
    // report AT a station either, and the reply must not look like an answer.
    const bare = makeHostWithoutSuper();
    const r = await call(bare.host, "read_superelevation", { atStation: 1500 });
    expect(r.enabled).toBe(false);
    expect(r.atStation).toBeUndefined();
    expect(String(r.note)).toContain("set_superelevation");
  });

  it("still returns the whole policy when no station is asked for", async () => {
    const h = makeHost();
    const r = await call(h.host, "read_superelevation", {});
    expect(r.enabled).toBe(true);
    expect(r.atStation).toBeUndefined();
    expect(Array.isArray(r.transitions)).toBe(true);
  });
});

describe("F005 -- both exports describe the same coordinate system", () => {
  it("the staking CSV carries the selected CRS, as the Studio download does", async () => {
    const h = makeHost();
    const r = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    expect(String(r.csv)).toContain("2240");
    expect(String(r.csv)).not.toContain("CRS not set");
    expect(r.coordinateSystem).toMatchObject({ zone: "GA-West", epsgCode: 2240 });
  });

  it("CSV and LandXML agree with each other", async () => {
    const h = makeHost();
    const csv = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    const xml = await call(h.host, "export_landxml", {});
    expect(String(csv.csv)).toContain("2240");
    expect(String(xml.landxml)).toContain("2240");
  });

  it("says so honestly when no CRS is selected", async () => {
    const h = makeHost(null);
    const r = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    expect(String(r.csv)).toContain("CRS not set");
    expect(r.coordinateSystem).toBeNull();
  });
});

describe("F008 -- lengthBytes is a byte count", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", async () => {
    const h = makeHost();
    const r = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    const csv = String(r.csv);
    expect(r.lengthBytes).toBe(new TextEncoder().encode(csv).length);
    expect(r.lengthChars).toBe(csv.length);
  });

  it("the two differ whenever the export carries a multi-byte character", async () => {
    // The CRS header line uses an em dash, which is 3 bytes and 1 code unit.
    const h = makeHost();
    const r = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    if (/[^ -]/.test(String(r.csv))) {
      expect(r.lengthBytes as number).toBeGreaterThan(r.lengthChars as number);
    }
  });

  it("applies to the LandXML export too", async () => {
    const h = makeHost();
    const r = await call(h.host, "export_landxml", {});
    expect(r.lengthBytes).toBe(new TextEncoder().encode(String(r.landxml)).length);
  });
});
