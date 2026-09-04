const MAX_DIFF_LINES = 2000;

/**
 * A unified-ish diff, because "prints exactly what it would do" is the whole contract of this verb
 * and a summary of a change to someone's settings file is not that. Three lines of context, and a
 * plain before/after dump past the size where the LCS table stops being cheap.
 */
export function unifiedDiff(before: string, after: string, context = 3): string[] {
  const a = splitKeepingShape(before);
  const b = splitKeepingShape(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return windowedDiff(a, b, context);
  }

  const marked = markChanges(a, b);
  const keep = new Set<number>();
  for (const [i, line] of marked.entries()) {
    if (line.mark === " ") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(marked.length - 1, i + context); j++) {
      keep.add(j);
    }
  }

  const out: string[] = [];
  let skipped = 0;
  for (const [i, line] of marked.entries()) {
    if (!keep.has(i)) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      out.push(elision(skipped, "unchanged"));
      skipped = 0;
    }
    out.push(`${line.mark} ${line.text}`);
  }
  if (skipped > 0) out.push(elision(skipped, "unchanged"));
  return out;
}

function elision(count: number, kind: string): string {
  return `  … ${count} ${kind} line${count === 1 ? "" : "s"}`;
}

/**
 * The fallback past the size where the LCS table stops being cheap. It used to dump both whole
 * files, which for a 3000-line settings file is 6000 lines describing a four-line insertion. The
 * insertion point does not need an LCS to find: matching lines at each end are matching lines, and
 * what is left between them is the change.
 */
function windowedDiff(a: string[], b: string[], context: number): string[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const leading = Math.min(context, head);
  const trailing = Math.min(context, tail);
  const out: string[] = [];
  if (head - leading > 0) out.push(elision(head - leading, "unchanged"));
  for (const line of a.slice(head - leading, head)) out.push(`  ${line}`);
  out.push(
    ...capped(
      a.slice(head, a.length - tail).map((line) => `- ${line}`),
      b.slice(head, b.length - tail).map((line) => `+ ${line}`),
    ),
  );
  for (const line of a.slice(a.length - tail, a.length - tail + trailing)) out.push(`  ${line}`);
  if (tail - trailing > 0) out.push(elision(tail - trailing, "unchanged"));
  return out;
}

/** A change big enough to fill this budget is one nobody reads to the end of either. */
function capped(removed: string[], added: string[]): string[] {
  if (removed.length + added.length <= MAX_DIFF_LINES) return [...removed, ...added];
  const half = Math.floor(MAX_DIFF_LINES / 2);
  const shown = (lines: string[], kind: string): string[] =>
    lines.length <= half ? lines : [...lines.slice(0, half), elision(lines.length - half, kind)];
  return [...shown(removed, "further removed"), ...shown(added, "further added")];
}

function splitKeepingShape(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface MarkedLine {
  mark: " " | "-" | "+";
  text: string;
}

// biome-ignore-start lint/style/noNonNullAssertion: the LCS table and the walk over it are index
// arithmetic — every read is bounded by the loop that produced the index, and the table's rows are
// allocated up front. Checking each read would add branches no input can reach, in the one loop
// here that is O(before × after).
function markChanges(a: string[], b: string[]): MarkedLine[] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: MarkedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ mark: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ mark: "-", text: a[i]! });
      i++;
    } else {
      out.push({ mark: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ mark: "-", text: a[i++]! });
  while (j < b.length) out.push({ mark: "+", text: b[j++]! });
  return out;
}
// biome-ignore-end lint/style/noNonNullAssertion: end of the index-arithmetic region
