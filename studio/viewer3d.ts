// Full-screen 3D corridor view — DOM/three.js glue only. All geometry math
// lives in tested modules (kernel/corridor, viewer/corridor-mesh, util/station).
//
// Created lazily on first switch to the 3D view, so WebGL never runs (and can
// never fail) unless the user opens it. createViewer THROWS when the browser
// cannot create a WebGL context — the caller must catch and degrade.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { computeCorridor } from "../src/kernel/corridor";
import { buildCorridorMesh, type CorridorMesh } from "../src/viewer/corridor-mesh";
import { fmtSta } from "../src/util/station";
import type { RoadDesign } from "../src/schema/road-design";
import type { Tin } from "../src/kernel/terrain";
import { buildRoadsideGeometry } from "../src/viewer/roadside-mesh";
import { buildDesignSectionMesh } from "../src/viewer/design-section-mesh";
import { buildPavementMeshes, pavementLayerColors } from "../src/viewer/pavement-mesh";
import type { DesignSectionSurface } from "../src/importers/design-sections";
import { assignSurfaceColors, describeCodes,
  type SurfaceAppearance } from "../src/viewer/surface-appearance";
import type { PlanFeatureSet } from "../src/importers/plan-features";

const SECTION_INTERVAL_FT = 25;

export interface Viewer3D {
  /** Recompute the corridor and rebuild the scene. Throws on kernel errors. */
  update(design: RoadDesign): void;
  /** Show the existing site -- buildings, kerbs, lot lines -- or undefined to remove it. */
  setPlanFeatures(set: PlanFeatureSet | undefined): void;
  /** Show the original designer's as-designed sections, or [] to remove them. */
  setDesignSections(sections: readonly DesignSectionSurface[]): void;
  /** Show existing ground under the road, or pass undefined to remove it.
   *  Redrawn on the next update() so it shares the corridor's origin. */
  setTerrain(tin: Tin | undefined): void;
  /** Vertical exaggeration (y scale). 1 = true scale. */
  setExaggeration(factor: number): void;
  /** Start/stop the render loop (stop when the view is hidden). */
  setActive(active: boolean): void;
  /**
   * Frame the imported ground rather than the road.
   *
   * Terrain that does not overlap the alignment is drawn where it really is,
   * which can be miles away -- the camera is fitted to the corridor, so the
   * engineer sees an empty view and concludes the import failed. Returns how
   * far the ground sits from the road, or undefined when there is none.
   */
  fitToGround(): { offsetFt: number; name: string } | undefined;
}

export interface LegendEntry {
  name: string;
  /** CSS color the template's surface is painted with */
  color: string;
}

/**
 * Colours for AUTHORED materials. A segment the engineer has called asphalt is
 * drawn as asphalt; one with no stated material falls through to the palette
 * below and is only distinguished from its neighbours, not characterised.
 *
 * ⛔ Nothing here infers material from a segment's NAME. "shoulder" is asphalt on
 * one project and gravel on the next, and guessing would put a surface on the
 * drawing that nobody authored.
 */
const MATERIAL_COLOR: Readonly<Record<string, number>> = {
  asphalt: 0x3a3f45,
  concrete: 0xa9a79f,
  gravel: 0x8a7f6a,
  grass: 0x4a6b3a,
  earth: 0x6b5a45,
};

/** Fallback for segments with no authored material. Distinguishes, does not describe. */
const PALETTE = [0x8b949e, 0x2f81f7, 0x2ea043, 0xd29922, 0xa371f7, 0xdb6d28];

/** Painted markings, drawn where surfaces actually meet. */
const centrelineMaterial = new THREE.LineBasicMaterial({ color: 0xe8d44d });

/** Roadside furniture, by kind. Steel reads cool, concrete warm, paint bright. */
const ROADSIDE_MATERIAL: Readonly<Record<string, THREE.Material>> = {
  guardrail: new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide }),
  "concrete-barrier": new THREE.MeshStandardMaterial({ color: 0xb8b4aa, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
  curb: new THREE.MeshStandardMaterial({ color: 0xc2beb4, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
};
const markingMaterial = new THREE.LineBasicMaterial({ color: 0xf2f2f2 });
const edgeOfPavementMaterial = new THREE.LineBasicMaterial({ color: 0xe8e8e8 });

export function createViewer(
  container: HTMLElement,
  onReadout: (text: string) => void,
  onLegend: (entries: LegendEntry[]) => void,
): Viewer3D {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14181d);

  const camera = new THREE.PerspectiveCamera(50, 1, 1, 100_000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // Capped at 2: past that the backing buffer grows quadratically for detail no
  // one can see, and a corridor mesh is already the expensive thing on the page.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // ORD-style wheel zoom: zoom toward/away from the cursor position, so the
  // point under the cursor stays put (MicroStation view mechanics). Speed
  // raised from the three.js default — roads are long; getting from overview
  // to pavement level should take a few flicks, not twenty.
  controls.zoomToCursor = true;
  controls.zoomSpeed = 1.8;

  scene.add(new THREE.HemisphereLight(0xb8c4d0, 0x2a2f36, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 1);
  scene.add(sun);

  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x30363d });
  const clMaterial = new THREE.LineBasicMaterial({ color: 0xd29922 });
  let roadMaterials: THREE.MeshStandardMaterial[] = [];
  let labelDisposables: (THREE.Texture | THREE.Material)[] = [];
  // Sprites inherit group.scale.y — counter-scale so labels stay readable
  // at any vertical exaggeration.
  let labelSprites: { sprite: THREE.Sprite; baseH: number }[] = [];

  // Floating station label for a drop boundary (canvas sprite, billboard).
  function makeLabel(text: string, widthFt: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 80;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(20, 24, 29, 0.82)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#e8eef4";
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    ctx.font = "44px Consolas, monospace";
    ctx.fillStyle = "#e8eef4";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    labelDisposables.push(tex, mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(widthFt, widthFt * (80 / 512), 1);
    return sprite;
  }

  const group = new THREE.Group();
  scene.add(group);
  let exaggeration = 1;
let terrainTin: Tin | undefined;
let designSectionSurfaces: readonly DesignSectionSurface[] = [];
let sitePlanFeatures: PlanFeatureSet | undefined;
/** Existing site linework: cool and thin, so the design reads over it. */
const siteFeatureMaterial = new THREE.LineBasicMaterial({ color: 0x6f8fa8 });
/**
 * Reference surfaces get their OWN colour, not one shared constant.
 *
 * ⛔ Every imported reference surface used to share a single translucent brown,
 * so a file carrying five distinct surfaces -- pavement, wearing course,
 * terrace, rock, soil -- rendered as one indistinguishable mass. The colour
 * comes from the surface's resolved appearance: its authored material where the
 * file states one, otherwise a stable identity colour derived from its name.
 * Translucency is kept so the app's own corridor still reads on top.
 */
/**
 * A reference surface's display appearance.
 *
 * A DesignCrossSectSurf is not a TIN and carries no MaterialTable of its own,
 * so it falls to surface identity plus whatever its point codes say. The label
 * is built here so the legend and the mesh cannot disagree about it.
 */
/**
 * What a surface's point codes amount to, in words a reader can act on.
 *
 * ⛔ ONE builder. The legend used to compose its own near-copy of this string,
 * so the two could drift and only one of them was ever displayed -- `codeNote`
 * was built on every surface and read by nothing.
 *
 * ⚠ Counts, not just names. "no codes · 12 uncoded" told a reader what was
 * ABSENT twice and what was present never; "12 points, all uncoded" says the
 * same fact as a fact. Where codes do exist, a bare list cannot distinguish a
 * code marking four points from one marking four thousand, so each carries its
 * count and the busiest come first.
 */
function surfaceLook(
  surf: DesignSectionSurface,
  colours: Map<string, number>,
): SurfaceAppearance & { codeNote: string } {
  return {
    colorHex: colours.get(surf.name) ?? 0x8b949e,
    label: surf.name,
    source: "surface-identity",
    codeNote: describeCodes(surf),
  };
}

/** Pavement courses are solid, unlike the translucent reference surfaces. */
const pavementMaterials = new Map<number, THREE.MeshStandardMaterial>();
function pavementMaterial(colorHex: number): THREE.MeshStandardMaterial {
  const cached = pavementMaterials.get(colorHex);
  if (cached) return cached;
  const made = new THREE.MeshStandardMaterial({
    color: colorHex, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
  pavementMaterials.set(colorHex, made);
  return made;
}

const referenceMaterials = new Map<number, THREE.MeshStandardMaterial>();
function referenceMaterial(colorHex: number): THREE.MeshStandardMaterial {
  let m = referenceMaterials.get(colorHex);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: colorHex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.55,
    });
    referenceMaterials.set(colorHex, m);
  }
  return m;
}
let terrainMesh: THREE.Mesh | undefined;

/** Earth-toned, matte, and drawn slightly back so the road reads on top of it. */
const terrainMaterial = new THREE.MeshStandardMaterial({
  color: 0x6b6a52,
  roughness: 1,
  metalness: 0,
  side: THREE.DoubleSide,
  flatShading: true,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});

/** Ground materials, one per authored colour, cached like the reference ones. */
const groundMaterials = new Map<number, THREE.MeshStandardMaterial>();
function groundMaterialFor(tin: Tin): THREE.MeshStandardMaterial {
  const hexColor = tin.appearance?.source === "authored-material"
    ? tin.appearance.colorHex : undefined;
  if (hexColor === undefined) return terrainMaterial;
  const cached = groundMaterials.get(hexColor);
  if (cached) return cached;
  const made = terrainMaterial.clone();
  made.color.setHex(hexColor);
  groundMaterials.set(hexColor, made);
  return made;
}


/**
 * Build the ground mesh in the corridor's own local frame.
 *
 * Uses the SAME origin as the road: a terrain drawn about its own centre would
 * float somewhere else entirely, which looks like a rendering bug and is really a
 * coordinate one. Points far from the road are dropped -- a survey often covers
 * far more ground than the alignment touches, and drawing all of it shrinks the
 * road to a speck.
 */
function buildTerrainMesh(tin: Tin, origin: { e: number; n: number; z: number }, reachFt: number)
  : THREE.Mesh | undefined {
  const keep = new Int32Array(tin.points.length).fill(-1);
  const pos: number[] = [];
  let kept = 0;
  for (let i = 0; i < tin.points.length; i += 1) {
    const p = tin.points[i]!;
    if (Math.hypot(p.e - origin.e, p.n - origin.n) > reachFt) continue;
    keep[i] = kept++;
    pos.push(p.e - origin.e, p.z - origin.z, -(p.n - origin.n));
  }
  if (kept < 3) return undefined;

  const idx: number[] = [];
  for (const f of tin.faces) {
    const a = keep[f[0]]!, b2 = keep[f[1]]!, c = keep[f[2]]!;
    if (a < 0 || b2 < 0 || c < 0) continue;
    idx.push(a, b2, c);
  }
  if (idx.length === 0) return undefined;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // The surface's own colour when the file authored one, otherwise the shared
  // earth tone. A 2.0 file that states its ground is grey should not be drawn
  // in an invented brown just because that is what ground usually looks like.
  return new THREE.Mesh(geo, groundMaterialFor(tin));
}
  let fitted = false;
  let lastDesignForTerrain: RoadDesign | undefined;
let meshData: CorridorMesh | null = null;
  let roadMesh: THREE.Mesh | null = null;
  let snapPoints: THREE.Points | null = null;

  // Snap markers live in scene space (not the exaggerated group) so the
  // spheres never squash; local (unexaggerated) positions kept for rescale.
  const snapMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xe8eef4, depthTest: false }),
  );
  snapMarker.visible = false;
  scene.add(snapMarker);
  const pinMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xd29922, depthTest: false }),
  );
  pinMarker.visible = false;
  scene.add(pinMarker);
  let snapLocal: THREE.Vector3 | null = null;
  let pinLocal: THREE.Vector3 | null = null;
  let snapText = "";
  let pinnedText: string | null = null;

  // Markers render at constant SCREEN size: rescaled every frame from the
  // camera distance (a road-length-based radius dwarfed short corridors).
  function placeMarker(m: THREE.Mesh, local: THREE.Vector3): void {
    m.position.set(local.x, local.y * exaggeration, local.z);
    m.scale.setScalar(camera.position.distanceTo(m.position) * 0.004);
    m.visible = true;
  }

  function emitReadout(live: string): void {
    onReadout(pinnedText !== null ? `⊙ ${pinnedText}` : live);
  }

  function resize(): void {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    // ⚠ updateStyle MUST be true. setSize(w, h, false) leaves the canvas with no
    // CSS size of its own, so the element lays out at its BACKING-BUFFER size --
    // which setPixelRatio has already multiplied by devicePixelRatio. On a 1.5x
    // display a 1280x720 viewport got an 1897x945 canvas and the page overflowed
    // in both directions. Backing resolution and CSS layout size are different
    // things and only one of them belongs in the layout.
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function fitCamera(): void {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.z, 100);
    camera.position.set(center.x - d * 0.35, center.y + d * 0.3, center.z + d * 0.45);
    camera.near = d / 1000;
    camera.far = d * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }

  function clearGroup(): void {
    for (const child of [...group.children]) {
      group.remove(child);
      (child as THREE.Mesh | THREE.Line).geometry?.dispose();
    }
    for (const m of roadMaterials) m.dispose();
    roadMaterials = [];
    for (const d of labelDisposables) d.dispose();
    labelDisposables = [];
    labelSprites = [];
    snapPoints = null;
  }

  // Cursor readout. Snap-first (AccuSnap-style): template points are exact
  // kernel values — when the cursor is near one, lock onto it and report its
  // true station/offset/elevation. Otherwise fall back to the interpolated
  // surface readout (marked with ~).
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function castFrom(ev: PointerEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (!roadMesh || !meshData) return;
    castFrom(ev);

    // 1) Try the snap layer — threshold scales with view distance so the
    //    magnet feels constant on screen.
    const viewDist = camera.position.distanceTo(controls.target);
    raycaster.params.Points = { threshold: viewDist * 0.012 };
    const snapHit = snapPoints ? raycaster.intersectObject(snapPoints, false)[0] : undefined;
    if (snapHit && snapHit.index !== undefined) {
      const i = snapHit.index;
      const meta = meshData.pointMeta[i]!;
      const station = meshData.stations[meta.sectionIndex]!;
      const template = meshData.sectionTemplates[meta.sectionIndex] ?? "";
      const elev = meshData.origin.z + meshData.positions[i * 3 + 1]!;
      const offTxt =
        meta.side === "CL" ? "CL (0.00 ft)" : `${meta.offset.toFixed(2)} ft ${meta.side}`;
      snapLocal = new THREE.Vector3(
        meshData.positions[i * 3]!,
        meshData.positions[i * 3 + 1]!,
        meshData.positions[i * 3 + 2]!,
      );
      snapText = `● STA ${fmtSta(station)}   ${offTxt}   elev ${elev.toFixed(2)} ft   ${meta.name} · ${template}`;
      placeMarker(snapMarker, snapLocal);
      emitReadout(snapText);
      return;
    }
    snapMarker.visible = false;
    snapLocal = null;
    snapText = "";

    // 2) Fall back to the interpolated surface readout.
    const hit = raycaster.intersectObject(roadMesh, false)[0];
    if (!hit) {
      emitReadout("");
      return;
    }
    const p = hit.point; // world coords (y is exaggerated)
    const cl = meshData.centerline;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < meshData.stations.length; i++) {
      const dx = cl[i * 3]! - p.x;
      const dz = cl[i * 3 + 2]! - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const station = meshData.stations[best]!;
    const template = meshData.sectionTemplates[best] ?? "";
    const offset = Math.sqrt(bestD);
    // Side: cross product of centerline direction and the lateral vector
    // (three.js y-up; +z is south). Positive → right of stationing.
    const j = Math.min(best, meshData.stations.length - 2);
    const dirX = cl[(j + 1) * 3]! - cl[j * 3]!;
    const dirZ = cl[(j + 1) * 3 + 2]! - cl[j * 3 + 2]!;
    const latX = p.x - cl[best * 3]!;
    const latZ = p.z - cl[best * 3 + 2]!;
    const side = dirX * latZ - dirZ * latX >= 0 ? "R" : "L";
    const elev = meshData.origin.z + p.y / exaggeration;
    emitReadout(
      `~ STA ${fmtSta(station)}   ${offset.toFixed(1)} ft ${side}   elev ${elev.toFixed(2)} ft   ${template}`,
    );
  });
  renderer.domElement.addEventListener("pointerleave", () => emitReadout(""));

  // Click while snapped → pin the exact point (gold marker, readout locked);
  // click empty space → unpin. A drag (orbit) never pins.
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return; // drag, not a pick
    if (snapLocal) {
      pinLocal = snapLocal.clone();
      pinnedText = snapText;
      placeMarker(pinMarker, pinLocal);
    } else {
      pinLocal = null;
      pinnedText = null;
      pinMarker.visible = false;
    }
    emitReadout("");
  });

  return {
    setPlanFeatures(set: PlanFeatureSet | undefined): void {
      sitePlanFeatures = set;
      if (lastDesignForTerrain) this.update(lastDesignForTerrain);
    },
    setDesignSections(sections: readonly DesignSectionSurface[]): void {
      designSectionSurfaces = sections;
      if (lastDesignForTerrain) this.update(lastDesignForTerrain);
    },
    setTerrain(tin: Tin | undefined): void {
      terrainTin = tin;
      if (meshData) this.update(lastDesignForTerrain ?? (undefined as unknown as RoadDesign));
    },
    update(design: RoadDesign): void {
      if (design) lastDesignForTerrain = design;
      const mesh = buildCorridorMesh(computeCorridor(design, SECTION_INTERVAL_FT));
      meshData = mesh;
      clearGroup();

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
      geo.setIndex(mesh.indices);
      geo.computeVertexNormals();

      // One material per template (palette by first appearance); geometry
      // groups map each template run to its material — the drops become
      // visible as color changes, with a legend for the names.
      const matIndex = new Map<string, number>();
      for (const g of mesh.groups) {
        if (!matIndex.has(g.kind)) {
          const authored = MATERIAL_COLOR[g.kind];
          const color = authored ?? PALETTE[matIndex.size % PALETTE.length]!;
          matIndex.set(g.kind, roadMaterials.length);
          roadMaterials.push(
            new THREE.MeshStandardMaterial({
              color,
              // An authored material gets its own finish: asphalt is matt, concrete
              // and gravel less so. Unstated segments keep the old neutral look.
              roughness: authored === undefined ? 0.85 : g.kind === "asphalt" ? 0.97 : 0.9,
              metalness: 0.0,
              side: THREE.DoubleSide,
            }),
          );
        }
        geo.addGroup(g.start, g.count, matIndex.get(g.kind)!);
      }
      // One assignment across the whole set, so no two reference surfaces can
      // land on the same colour -- "Teoretisk" and "Berg" collide when each is
      // hashed on its own, which is two of five surfaces drawn identically.
      const referenceColours = assignSurfaceColors(
        designSectionSurfaces.filter((s) => s.maxWidthFt < 200).map((s) => s.name),
      );

      // ⛔ The legend names the SOURCE of every colour. A reader must be able to
      // tell an authored material from a display identity from a code category;
      // a colour whose origin cannot be stated is a guess wearing a legend.
      const legend: LegendEntry[] = [...matIndex.entries()].map(([name, mi]) => ({
        name,
        color: `#${roadMaterials[mi]!.color.getHexString()}`,
      }));
      if (terrainTin) {
        const a = terrainTin.appearance;
        // The regions and texture names the file authored, said out loud even
        // when they cannot be painted. Holding a reference and never showing it
        // is indistinguishable from having dropped it.
        // ⛔ "(identity)" is NOT repeated per entry any more. It was on almost
        // every row, so it read as noise rather than as the caveat it is; the
        // legend states it once, in its own header. What stays here is the part
        // that differs between surfaces -- the regions and texture names the
        // file authored, said out loud even when they cannot be painted, since
        // holding a reference and never showing it looks like having dropped it.
        const detail = a?.source === "authored-material"
          ? " — authored material"
          : a?.regionCount
            ? ` — ${a.regionCount} authored regions, ` +
              `${a.authoredMaterials?.length ?? 0} materials not painted`
            : "";
        legend.push({
          name: `ground: ${terrainTin.name}${detail}`,
          color: `#${groundMaterialFor(terrainTin).color.getHexString()}`,
        });
      }
      for (const surf of designSectionSurfaces) {
        if (surf.maxWidthFt >= 200) continue;
        const look = surfaceLook(surf, referenceColours);
        legend.push({
          // ⚠ The counts describe the POINTS, not the colour. The mesh is one
          // colour per surface, so a per-code colour key here would describe
          // something that is not drawn.
          name: `reference: ${look.label} — ${look.codeNote}`,
          color: `#${look.colorHex.toString(16).padStart(6, "0")}`,
        });
      }
      roadMesh = new THREE.Mesh(geo, roadMaterials);
      group.add(roadMesh);

      // The existing site. Features whose survey gave no elevation are drawn at the
      // corridor's own datum rather than at zero, which would drop them through the
      // ground; they are still drawn, because a building with no z is still there.
      if (sitePlanFeatures) {
        for (const f of sitePlanFeatures.features) {
          const pts: number[] = [];
          for (const q of f.points) {
            pts.push(q.e - meshData.origin.e, (q.z ?? meshData.origin.z) - meshData.origin.z,
              -(q.n - meshData.origin.n));
          }
          if (pts.length < 6) continue;
          const fg = new THREE.BufferGeometry();
          fg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
          group.add(new THREE.Line(fg, siteFeatureMaterial));
        }
      }

      // The original designer's pavement, when the imported file carried it.
      // Only the roadway-width surfaces: a 10,000 ft soil section is ground, not
      // pavement, and drawing it here would bury the road.
      for (const surf of designSectionSurfaces) {
        if (surf.maxWidthFt >= 200) continue;
        const dm = buildDesignSectionMesh(surf, design.alignment, meshData.origin);
        if (dm.indices.length === 0) continue;
        const dg = new THREE.BufferGeometry();
        dg.setAttribute("position", new THREE.Float32BufferAttribute(dm.positions, 3));
        dg.setIndex(dm.indices);
        dg.computeVertexNormals();
        const look = surfaceLook(surf, referenceColours);
        group.add(new THREE.Mesh(dg, referenceMaterial(look.colorHex)));
      }

      // Roadside furniture: guardrail, barrier, curb and markings, each swept
      // between the stations an engineer authored for it. Nothing appears here
      // that a person did not place.
      for (const r of buildRoadsideGeometry(design, meshData.origin)) {
        if (r.indices.length > 0) {
          const rg = new THREE.BufferGeometry();
          rg.setAttribute("position", new THREE.Float32BufferAttribute(r.positions, 3));
          rg.setIndex(r.indices);
          rg.computeVertexNormals();
          group.add(new THREE.Mesh(rg, ROADSIDE_MATERIAL[r.kind] ?? ROADSIDE_MATERIAL.guardrail!));
        }
        if (r.line.length >= 6) {
          const lg = new THREE.BufferGeometry();
          lg.setAttribute("position", new THREE.Float32BufferAttribute(r.line, 3));
          group.add(new THREE.Line(lg, r.kind === "pavement-marking" ? markingMaterial : edgeOfPavementMaterial));
        }
      }

      // The AUTHORED pavement structure, hanging under the running surface at
      // true thickness. Each course gets its own colour from a palette assigned
      // across the whole stack, so no two courses collide -- and the colours
      // distinguish courses only, never imply a material.
      const stacks = buildPavementMeshes(design, meshData.origin, SECTION_INTERVAL_FT);
      const stackColours = pavementLayerColors(stacks.length);
      stacks.forEach((L, i) => {
        if (L.indices.length === 0) return;
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.Float32BufferAttribute(L.positions, 3));
        pg.setIndex(L.indices);
        pg.computeVertexNormals();
        const colour = stackColours[i]!;
        group.add(new THREE.Mesh(pg, pavementMaterial(colour)));
        legend.push({
          // Exact authored name and inch value, verbatim.
          name: `pavement: ${L.name} ${L.thicknessIn}"` +
            (L.material ? ` (${L.material})` : "") + " — authored",
          color: `#${colour.toString(16).padStart(6, "0")}`,
        });
      });

      onLegend(legend);

      // Ground goes in last, in the road's frame, reaching a little past the
      // corridor so the road is seen sitting in the landscape rather than on a
      // postage stamp of it.
      if (terrainTin) {
        // Reach is derived from how far the road actually runs from its origin,
        // rather than a fixed radius that would be wrong at either scale.
        let far = 0;
        for (let i = 0; i < meshData.centerline.length; i += 3) {
          far = Math.max(far, Math.hypot(meshData.centerline[i]!, meshData.centerline[i + 2]!));
        }
        const reach = Math.max(600, far * 1.35);
        terrainMesh = buildTerrainMesh(terrainTin, meshData.origin, reach);
        // ⛔ Ground that does not reach the road is still ground. The reach
        // filter exists to stop a county-wide survey shrinking the road to a
        // speck, but when it keeps NOTHING the result was an import that
        // reported 25,140 triangles and drew nothing at all -- indistinguishable
        // from a parsing failure. Draw it where it really is instead, and let
        // fitToGround take the engineer to it.
        if (!terrainMesh) {
          const b = terrainTin.bounds;
          const cE = (b.minE + b.maxE) / 2, cN = (b.minN + b.maxN) / 2;
          const radius = Math.hypot(b.maxE - cE, b.maxN - cN);
          const away = Math.hypot(cE - meshData.origin.e, cN - meshData.origin.n);
          terrainMesh = buildTerrainMesh(terrainTin, meshData.origin, away + radius + 1);
          if (terrainMesh) terrainMesh.userData.offRoad = away;
        }
        if (terrainMesh) group.add(terrainMesh);
      } else {
        terrainMesh = undefined;
      }

      group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), edgeMaterial));

      const clGeo = new THREE.BufferGeometry();
      clGeo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.centerline, 3));
      group.add(new THREE.Line(clGeo, clMaterial));

      // Edge of pavement and centreline, lifted a hair so they read on the surface
      // rather than fighting it for the same depth. These are where the authored
      // surfaces meet -- not an authored striping plan, which nothing here holds.
      for (const line of mesh.edgeLines) {
        const pts = line.points.slice();
        for (let i = 1; i < pts.length; i += 3) pts[i] = pts[i]! + 0.05;
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        group.add(new THREE.Line(
          g2,
          line.kind === "centreline" ? centrelineMaterial : edgeOfPavementMaterial,
        ));
      }

      // Invisible snap layer: one point per template point, raycast targets
      // for the AccuSnap-style cursor (geometry shared with nothing else).
      const snapGeo = new THREE.BufferGeometry();
      snapGeo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
      const snapMat = new THREE.PointsMaterial({ size: 0.0001, transparent: true, opacity: 0 });
      labelDisposables.push(snapMat);
      snapPoints = new THREE.Points(snapGeo, snapMat);
      group.add(snapPoints);

      // Design changed: any pinned point may no longer exist.
      pinLocal = null;
      pinnedText = null;
      pinMarker.visible = false;
      snapMarker.visible = false;
      snapLocal = null;

      // Drop boundaries: bright section ring + floating station label —
      // visible at any zoom, like a match line on plans.
      const roadLength =
        (mesh.stations[mesh.stations.length - 1] ?? 0) - (mesh.stations[0] ?? 0);
      const labelW = Math.max(roadLength * 0.07, 120);
      for (const b of mesh.boundaries) {
        const ringGeo = new THREE.BufferGeometry();
        ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(b.loop, 3));
        const ringMat = new THREE.LineBasicMaterial({ color: 0xe8eef4, depthTest: false });
        labelDisposables.push(ringMat);
        group.add(new THREE.Line(ringGeo, ringMat));

        const mid = Math.floor(b.loop.length / 6) * 3; // middle vertex of the row
        const label = makeLabel(`${fmtSta(b.station)} · ${b.template}`, labelW);
        label.position.set(
          b.loop[mid]!,
          b.loop[mid + 1]! + labelW * 0.12,
          b.loop[mid + 2]!,
        );
        const baseH = label.scale.y;
        label.scale.y = baseH / exaggeration;
        labelSprites.push({ sprite: label, baseH });
        group.add(label);
      }

      group.scale.y = exaggeration;
      if (!fitted) {
        fitCamera();
        fitted = true;
      }
    },
    setExaggeration(factor: number): void {
      exaggeration = factor;
      group.scale.y = factor;
      for (const { sprite, baseH } of labelSprites) sprite.scale.y = baseH / factor;
      if (snapLocal && snapMarker.visible) placeMarker(snapMarker, snapLocal);
      if (pinLocal && pinMarker.visible) placeMarker(pinMarker, pinLocal);
    },
    fitToGround(): { offsetFt: number; name: string } | undefined {
      if (!terrainMesh || !terrainTin) return undefined;
      const box = new THREE.Box3().setFromObject(terrainMesh);
      if (box.isEmpty()) return undefined;
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const d = Math.max(size.x, size.z, 100);
      camera.position.set(centre.x - d * 0.35, centre.y + d * 0.45, centre.z + d * 0.45);
      camera.near = d / 1000;
      camera.far = d * 20;
      camera.updateProjectionMatrix();
      controls.target.copy(centre);
      controls.update();
      return {
        offsetFt: Number((terrainMesh.userData.offRoad ?? 0).toFixed(2)),
        name: terrainTin.name,
      };
    },
    setActive(active: boolean): void {
      if (active) {
        resize();
        renderer.setAnimationLoop(() => {
          controls.update();
          // keep snap/pin markers screen-constant while the camera moves
          for (const m of [snapMarker, pinMarker]) {
            if (m.visible) m.scale.setScalar(camera.position.distanceTo(m.position) * 0.004);
          }
          renderer.render(scene, camera);
        });
      } else {
        renderer.setAnimationLoop(null);
      }
    },
  };
}
