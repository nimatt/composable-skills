export interface FrontmatterSplit {
  ok: true;
  frontmatter: string;
  body: string;
  bodyOffset: number;
}

export interface FrontmatterError {
  ok: false;
  message: string;
}

const FENCE = /^---[ \t]*$/;

export function splitFrontmatter(text: string): FrontmatterSplit | FrontmatterError {
  const lines = text.split("\n");
  const first = lines[0];
  if (first === undefined || !FENCE.test(first)) {
    /**
     * Invariant 1 is enforced by comparing the template's frontmatter region against the output's.
     * A file whose fence is not on line 1 has no frontmatter region at all, so every check that
     * guards that region passes vacuously and a slot between the fences becomes ordinary body an
     * override may fill. Refusing the whole shape closes that class, rather than the two ways
     * (a BOM, a leading blank line) it is currently reachable.
     */
    for (const line of lines) {
      if (FENCE.test(line)) {
        return {
          ok: false,
          message:
            "`---` opens a frontmatter fence but is not the first line of the file — " +
            "move it to line 1, or indent it so it is not a fence",
        };
      }
      if (line.trim() !== "") break;
    }
    return { ok: true, frontmatter: "", body: text, bodyOffset: 0 };
  }

  for (let i = 1; i < lines.length; i++) {
    // The scan starts after the opening fence, and `i` goes on to slice `lines` itself.
    // biome-ignore lint/style/noNonNullAssertion: `.entries()` would need a slice plus an offset
    if (FENCE.test(lines[i]!)) {
      const frontmatter = `${lines.slice(0, i + 1).join("\n")}\n`;
      const body = lines.slice(i + 1).join("\n");
      return { ok: true, frontmatter, body, bodyOffset: i + 1 };
    }
  }

  return { ok: false, message: "frontmatter opened with `---` but never closed" };
}

export function frontmatterFields(frontmatter: string): string[] {
  const fields: string[] = [];
  for (const line of frontmatter.split("\n").slice(1)) {
    if (FENCE.test(line)) break;
    const field = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1];
    if (field !== undefined) fields.push(field);
  }
  return fields;
}
