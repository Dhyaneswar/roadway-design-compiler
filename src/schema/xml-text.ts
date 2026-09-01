/**
 * Which characters an authored string may contain if it is going to end up in
 * a LandXML file.
 *
 * F034. Escaping `&`, `<`, `>` and quotes makes metacharacters safe; it does
 * nothing about characters XML 1.0 CANNOT REPRESENT AT ALL. `AB` was
 * accepted by the schema, survived the form, passed through the escaper
 * unchanged, and produced a "successful" export that Chrome's own parser
 * rejected. A deliverable that reports success and cannot be opened is the
 * worst failure mode available: the engineer finds out in the CAD package.
 *
 * XML 1.0 §2.2:
 *   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * So U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, the noncharacters U+FFFE and
 * U+FFFF, and any LONE surrogate are unrepresentable. There is no escape for
 * them -- `&#1;` is itself illegal in XML 1.0 -- so the only honest answers are
 * to refuse or to silently alter the author's text. We refuse, and name the
 * offending code point.
 *
 * ⚠ TAB, LF and CR are DELIBERATELY ALLOWED. They are legal characters, and the
 * exporter writes them as numeric character references so they survive XML
 * attribute-value normalisation, which would otherwise turn each into a space.
 * Allowing them costs one rule in the exporter and avoids refusing a name whose
 * only sin is a pasted line break.
 */

export interface IllegalXmlChar {
  /** Index into the string, by code unit. */
  index: number;
  /** The offending code point. */
  codePoint: number;
  /** `U+0001`, for a message a person can act on. */
  label: string;
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** The first character XML 1.0 cannot carry, or undefined when the text is safe. */
export function firstIllegalXmlChar(text: string): IllegalXmlChar | undefined {
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const legal =
      cp === 0x9 || cp === 0xa || cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    // A well-formed surrogate PAIR already decoded to >= 0x10000 above; anything
    // still sitting in the surrogate range here is a lone half.
    if (!legal) return { index: i, codePoint: cp, label: hex(cp) };
    i += width;
  }
  return undefined;
}

/** True when every character can be written into a LandXML document. */
export const isXmlSafeText = (text: string): boolean =>
  firstIllegalXmlChar(text) === undefined;

/** Why a string was refused, in words an engineer can act on. */
export function illegalXmlCharMessage(text: string, field = "name"): string | undefined {
  const bad = firstIllegalXmlChar(text);
  if (!bad) return undefined;
  return (
    `${field} contains ${bad.label} at position ${bad.index}, which XML 1.0 cannot ` +
    `represent. LandXML has no escape for it, so the file would be written but ` +
    `would not open. Remove the character rather than relying on the export to ` +
    `drop it: silently altering an authored name is how the wrong road gets built.`
  );
}
