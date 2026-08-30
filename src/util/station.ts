// Station formatting — US survey-foot stationing, "STA+RR.RR".

export function fmtSta(v: number): string {
  const s = Math.floor(v / 100);
  const r = v - s * 100;
  return `${s}+${r.toFixed(2).padStart(5, "0")}`;
}
