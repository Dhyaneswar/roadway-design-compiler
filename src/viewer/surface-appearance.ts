// How an imported surface is coloured, and why.
//
// Three sources, kept strictly apart, in the precedence independent QA signed
// off. Blending them into one unexplained palette is the thing to avoid: a
// viewer that cannot say WHERE a colour came from is inventing engineering
// meaning whether or not it meant to.
//
//   1. SURFACE IDENTITY -- the neutral fallback. Every imported surface gets a
//      stable colour derived from its name, so two surfaces are told apart.
//      This is display identity and nothing more. It says "this is a different
//      surface from that one", never "this is asphalt".
//
//   2. AUTHORED APPEARANCE -- LandXML 2.0 MaterialTable RGB, used exactly as
//      the file states it, where a boundary reference resolves unambiguously.
//      This is the designer's own colour and outranks identity.
//
//   3. CODE CATEGORIES -- raw point codes as a deliberate categorical view.
//      The legend shows the exact code string. Nothing here maps a code to a
//      material or an engineering meaning; "KS" is "KS", not asphalt.
//
// ⛔ An uncoded point is its own visible bucket, never silently folded into a
// neighbouring category. On the file this was measured against, one surface has
// 2,873 coded points and another has 4,499 with no code at all -- a palette
// that only covers codes leaves that second surface indistinguishable.

/** A LandXML 2.0 material, as written. */
export interface AuthoredMaterial {
  index: number;
  /** RGB 0-255, when the file gave a colour. */
  color?: readonly [number, number, number];
  textureImageRef?: string;
  symbolRef?: string;
}

/** What a surface's boundaries reference. */
export interface SurfaceMaterialUse {
  /** Distinct material indices referenced by this surface's boundaries. */
  indices: number[];
  /** How many boundary regions in total. */
  regionCount: number;
}

export type AppearanceSource =
  | "authored-material"
  | "surface-identity"
  | "code-category"
  | "uncoded";

export interface SurfaceAppearance {
  /** 0xRRGGBB for the renderer. */
  colorHex: number;
  /** What the legend shows a person. Never a guessed material name. */
  label: string;
  source: AppearanceSource;
  /** Authored detail carried through even when it cannot be drawn. */
  note?: string;
  /**
   * The materials this surface's boundaries actually reference.
   *
   * ⛔ RETAINED even when they cannot be painted. A multi-material surface falls
   * back to an identity colour, and it used to drop the material list with it --
   * so the app held a file with 24 authored colours and 71 texture regions and
   * could not name any of them. Preserving a reference you cannot render is the
   * difference between "not supported yet" and "silently discarded".
   */
  authoredMaterials?: AuthoredMaterial[];
  /** How many boundary regions reference them. */
  regionCount?: number;
  /**
   * EVERY material the file declares, referenced by this surface or not.
   *
   * ⛔ Kept apart from authoredMaterials on purpose. Those are the ones this
   * surface's boundaries point at; this is the whole table. Olympus declares a
   * symbol-only material 1 that no boundary references, so a reader that only
   * returned the referenced subset dropped "OPPointSceneNode" entirely -- and
   * the app claimed to preserve a symbol it could not actually produce.
   * Conflating the two makes "declared in the file" and "used by this surface"
   * indistinguishable, which are different facts.
   */
  declaredMaterials?: AuthoredMaterial[];
}

/**
 * The neutral identity palette.
 *
 * Chosen to be distinguishable rather than descriptive, and deliberately NOT
 * the material palette used for authored segments -- a viewer should not be
 * able to confuse "surface 3" with "concrete".
 */
const IDENTITY_PALETTE: readonly number[] = [
  0x6b7f99, 0x8a7f6a, 0x7f6b8a, 0x6a8a7f, 0x99806b, 0x6b998f,
  0x8f6b99, 0x99946b, 0x7f998a, 0x996b7f, 0x6b8a99, 0x8a996b,
];

/**
 * A stable colour for a surface name.
 *
 * Stable across sessions and across import order: the same file always gives
 * the same surface the same colour, so a legend can be trusted between runs.
 * A plain sum would collide on anagrams, which real surface names ("Berg" /
 * "Breg") are close enough to hit.
 */
function fnv(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * A surface's colour when it is considered ALONE.
 *
 * ⚠ Two names can land on the same slot. Use assignSurfaceColors when drawing a
 * set together -- a legend of five surfaces showing four colours is worse than
 * no legend.
 */
export function stableSurfaceColor(name: string): number {
  return IDENTITY_PALETTE[fnv(name) % IDENTITY_PALETTE.length]!;
}

/**
 * Distinct identity colours for a KNOWN SET of surfaces.
 *
 * ⛔ Hashing each name independently is not enough. Measured on the real file,
 * "Teoretisk" and "Berg" hash to the same palette slot, so two of its five
 * surfaces rendered identically -- which is the exact problem this whole layer
 * exists to fix. Within a set, a collision walks to the next free slot.
 *
 * Still stable: the walk is done in sorted-name order, so the same file always
 * produces the same assignment whatever order the surfaces were imported in.
 * Beyond the palette size colours necessarily repeat, and the legend labels
 * carry the surface name regardless.
 */
export function assignSurfaceColors(names: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const name of [...new Set(names)].sort()) {
    const start = fnv(name) % IDENTITY_PALETTE.length;
    let slot = start;
    for (let i = 0; i < IDENTITY_PALETTE.length; i += 1) {
      const candidate = (start + i) % IDENTITY_PALETTE.length;
      if (!taken.has(candidate)) { slot = candidate; break; }
    }
    taken.add(slot);
    out.set(name, IDENTITY_PALETTE[slot]!);
  }
  return out;
}

/** Codes get their own palette, so a code view never looks like an identity view. */
const CODE_PALETTE: readonly number[] = [
  0x4c8fd4, 0xd4894c, 0x5cb85c, 0xc95c5c, 0x9b7fd4, 0xd4c14c, 0x4cd4c1, 0xd44c9b,
];

/** Uncoded is grey on purpose: visibly "not classified", not another category. */
export const UNCODED_COLOR = 0x8b949e;
export const UNCODED_LABEL = "uncoded";

export function codeColor(code: string, allCodes: readonly string[]): number {
  const i = allCodes.indexOf(code);
  if (i < 0) return UNCODED_COLOR;
  return CODE_PALETTE[i % CODE_PALETTE.length]!;
}

function hex(rgb: readonly [number, number, number]): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2]);
}

/**
 * Resolve one surface's display appearance.
 *
 * ⛔ An authored colour is used only when the surface's boundaries agree on a
 * single material. A surface whose regions reference SEVERAL materials is not
 * one colour, and painting the whole thing with one of them -- the first, the
 * commonest, any of them -- would be asserting something the file does not say.
 * Those fall back to identity and the regions are reported instead.
 */
export function resolveSurfaceAppearance(
  name: string,
  use: SurfaceMaterialUse | undefined,
  materials: readonly AuthoredMaterial[],
): SurfaceAppearance {
  const byIndex = new Map(materials.map((m) => [m.index, m]));

  const referenced = use
    ? use.indices.map((i) => byIndex.get(i)).filter((m): m is AuthoredMaterial => !!m)
    : [];
  const retained = {
    ...(referenced.length > 0
      ? { authoredMaterials: referenced, regionCount: use!.regionCount }
      : {}),
    ...(materials.length > 0 ? { declaredMaterials: [...materials] } : {}),
  };

  if (use && use.indices.length === 1) {
    const m = byIndex.get(use.indices[0]!);
    if (m?.color) {
      const extras: string[] = [];
      if (m.textureImageRef) extras.push(`texture "${m.textureImageRef}" is not rendered`);
      if (m.symbolRef) extras.push(`symbol "${m.symbolRef}" is not rendered`);
      return {
        colorHex: hex(m.color),
        label: `${name} — authored material ${m.index}`,
        source: "authored-material",
        note: extras.length > 0 ? extras.join("; ") : undefined,
        ...retained,
      };
    }
    if (m) {
      // A material with no colour, e.g. a symbol-only entry.
      return {
        colorHex: stableSurfaceColor(name),
        label: `${name} — surface identity`,
        source: "surface-identity",
        note: `material ${m.index} states no colour` +
          (m.symbolRef ? `, only symbol "${m.symbolRef}", which is not rendered` : ""),
        ...retained,
      };
    }
    return {
      colorHex: stableSurfaceColor(name),
      label: `${name} — surface identity`,
      source: "surface-identity",
      note: `boundary references material ${use.indices[0]}, which the file does not define`,
      ...retained,
    };
  }

  if (use && use.indices.length > 1) {
    return {
      colorHex: stableSurfaceColor(name),
      label: `${name} — surface identity`,
      source: "surface-identity",
      note: `${use.regionCount} authored material regions across ${use.indices.length} ` +
        `materials (${use.indices.join(", ")}); per-region painting is not implemented, so ` +
        "the surface is drawn in one identity colour rather than one of its materials" +
        (referenced.some((m) => m.textureImageRef || m.symbolRef)
          ? `. Textures/symbols referenced but not rendered: ` +
            referenced.flatMap((m) => [m.textureImageRef, m.symbolRef])
              .filter(Boolean).join(", ")
          : ""),
      ...retained,
    };
  }

  return {
    colorHex: stableSurfaceColor(name),
    label: `${name} — surface identity`,
    source: "surface-identity",
    ...retained,
  };
}

/**
 * The code categories present on a surface, in a stable order.
 *
 * Uncoded is always last and always present when any point lacks a code, so a
 * legend cannot imply every point was classified.
 */
export function codeCategories(
  codes: readonly (string | undefined)[],
): { label: string; colorHex: number; count: number; source: AppearanceSource }[] {
  const counts = new Map<string, number>();
  let uncoded = 0;
  for (const c of codes) {
    if (c === undefined || c === "") uncoded += 1;
    else counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const distinct = [...counts.keys()].sort();
  const out: { label: string; colorHex: number; count: number; source: AppearanceSource }[] =
    distinct.map((code) => ({
      label: code,
      colorHex: codeColor(code, distinct),
      count: counts.get(code)!,
      source: "code-category" as AppearanceSource,
    }));
  if (uncoded > 0) {
    out.push({ label: UNCODED_LABEL, colorHex: UNCODED_COLOR, count: uncoded,
      source: "uncoded" as AppearanceSource });
  }
  return out;
}
