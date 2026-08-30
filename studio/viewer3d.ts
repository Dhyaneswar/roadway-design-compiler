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

const SECTION_INTERVAL_FT = 25;

export interface Viewer3D {
  /** Recompute the corridor and rebuild the scene. Throws on kernel errors. */
  update(design: RoadDesign): void;
  /** Vertical exaggeration (y scale). 1 = true scale. */
  setExaggeration(factor: number): void;
  /** Start/stop the render loop (stop when the view is hidden). */
  setActive(active: boolean): void;
}

export interface LegendEntry {
  name: string;
  /** CSS color the template's surface is painted with */
  color: string;
}

/** Distinct surface colors, assigned per template by first appearance.
 *  Saturated on purpose — a lit surface washes out subtle tints. */
const PALETTE = [0x8b949e, 0x2f81f7, 0x2ea043, 0xd29922, 0xa371f7, 0xdb6d28];

export function createViewer(
  container: HTMLElement,
  onReadout: (text: string) => void,
  onLegend: (entries: LegendEntry[]) => void,
): Viewer3D {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14181d);

  const camera = new THREE.PerspectiveCamera(50, 1, 1, 100_000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
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
  let fitted = false;
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
    renderer.setSize(w, h, false);
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
    update(design: RoadDesign): void {
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
        if (!matIndex.has(g.template)) {
          const color = PALETTE[matIndex.size % PALETTE.length]!;
          matIndex.set(g.template, roadMaterials.length);
          roadMaterials.push(
            new THREE.MeshStandardMaterial({
              color,
              roughness: 0.85,
              metalness: 0.0,
              side: THREE.DoubleSide,
            }),
          );
        }
        geo.addGroup(g.start, g.count, matIndex.get(g.template)!);
      }
      onLegend(
        [...matIndex.entries()].map(([name, mi]) => ({
          name,
          color: `#${roadMaterials[mi]!.color.getHexString()}`,
        })),
      );
      roadMesh = new THREE.Mesh(geo, roadMaterials);
      group.add(roadMesh);

      group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), edgeMaterial));

      const clGeo = new THREE.BufferGeometry();
      clGeo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.centerline, 3));
      group.add(new THREE.Line(clGeo, clMaterial));

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
