// Generates the S1 spike sample: a LandXML file to import into OpenRoads/Civil 3D.
// Coordinates sit in a plausible Georgia West state plane range so the import
// lands somewhere sane; units are US survey feet.
import { writeFileSync, mkdirSync } from "node:fs";
import { toLandXML } from "../src/exporters/landxml";

const xml = toLandXML({
  name: "RDC-S1-SAMPLE",
  alignment: {
    beginStation: 1000,
    start: { e: 2_200_000, n: 1_350_000 },
    startAzimuthDeg: 75,
    elements: [
      { type: "tangent", length: 1200 },
      { type: "arc", radius: 1500, deltaDeg: 45, direction: "right" },
      { type: "tangent", length: 800 },
      { type: "arc", radius: 2000, deltaDeg: 30, direction: "left" },
      { type: "tangent", length: 1000 },
    ],
  },
  profile: {
    pvis: [
      { station: 1000, elevation: 850 },
      { station: 2500, elevation: 880, curveLength: 600 },
      { station: 4200, elevation: 846, curveLength: 800 },
      { station: 5178.1, elevation: 865.56 },
    ],
  },
});

mkdirSync("out", { recursive: true });
writeFileSync("out/RDC-S1-SAMPLE.xml", xml);
console.log("wrote out/RDC-S1-SAMPLE.xml");
