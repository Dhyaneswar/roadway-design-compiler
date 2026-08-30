// Angle utilities. Plan sheets print angles as degrees-minutes-seconds;
// the kernel works in decimal degrees.

export function dmsToDegrees(deg: number, min: number, sec: number): number {
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) {
    throw new RangeError("minutes and seconds must be in [0, 60)");
  }
  const sign = deg < 0 ? -1 : 1;
  return sign * (Math.abs(deg) + min / 60 + sec / 3600);
}

/** Decimal degrees → plan-sheet D°MM'SS.S" (seconds to 0.1", carry-safe). */
export function degreesToDms(deg: number): string {
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  let m = Math.floor((abs - d) * 60);
  let s = Math.round(((abs - d) * 60 - m) * 60 * 10) / 10;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(1).padStart(4, "0")}"`;
}

/** Azimuth (deg clockwise from north) → quadrant bearing, e.g. N 0°34'50.1" E. */
export function azimuthToBearing(azimuthDeg: number): string {
  const az = ((azimuthDeg % 360) + 360) % 360;
  if (az <= 90) return `N ${degreesToDms(az)} E`;
  if (az <= 180) return `S ${degreesToDms(180 - az)} E`;
  if (az <= 270) return `S ${degreesToDms(az - 180)} W`;
  return `N ${degreesToDms(360 - az)} W`;
}
