import { describe, test, expect } from "vitest";
import { fmtSta } from "../src/util/station";
import { degreesToDms, azimuthToBearing } from "../src/util/angle";

describe("degreesToDms", () => {
  test("formats the SR3 deflection 0.3126667° as 0°18'45.6\"", () => {
    expect(degreesToDms(0.3126666666666667)).toBe("0°18'45.6\"");
  });

  test("whole degrees", () => {
    expect(degreesToDms(30)).toBe("30°00'00.0\"");
  });

  test("seconds rounding does not produce 60.0\"", () => {
    expect(degreesToDms(0.5 + 59.96 / 3600)).toBe("0°31'00.0\"");
  });
});

describe("azimuthToBearing", () => {
  test("NE quadrant: azimuth 0.5805833° → N 0°34'50.1\" E", () => {
    expect(azimuthToBearing(0.5805833333333333)).toBe("N 0°34'50.1\" E");
  });

  test("SE quadrant: azimuth 135° → S 45°00'00.0\" E", () => {
    expect(azimuthToBearing(135)).toBe("S 45°00'00.0\" E");
  });

  test("SW quadrant: azimuth 200° → S 20°00'00.0\" W", () => {
    expect(azimuthToBearing(200)).toBe("S 20°00'00.0\" W");
  });

  test("NW quadrant: azimuth 271.366° → N 88°37'59.0\" W (Denham St)", () => {
    expect(azimuthToBearing(360 - (88 + 37 / 60 + 59 / 3600))).toBe("N 88°37'59.0\" W");
  });

  test("cardinal north", () => {
    expect(azimuthToBearing(0)).toBe("N 0°00'00.0\" E");
  });
});

describe("fmtSta", () => {
  test("formats whole stations", () => {
    expect(fmtSta(0)).toBe("0+00.00");
    expect(fmtSta(100)).toBe("1+00.00");
    expect(fmtSta(4714)).toBe("47+14.00");
  });

  test("formats fractional stations with two decimals", () => {
    expect(fmtSta(5178.1)).toBe("51+78.10");
    expect(fmtSta(123.456)).toBe("1+23.46");
  });

  test("pads the residual below 10 ft", () => {
    expect(fmtSta(1203.5)).toBe("12+03.50");
  });
});
