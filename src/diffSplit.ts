/** Build side-by-side rows from a unified diff hunk's lines. */

export type SplitSide = {
  text: string;
  kind: "ctx" | "add" | "del" | "empty";
  lineNo: number | null;
};

export type SplitRow = {
  left: SplitSide;
  right: SplitSide;
};

/**
 * Pair deletions with following additions; context on both sides.
 * Line numbers continue from oldStart / newStart.
 */
export function buildSplitRows(
  lines: string[],
  oldStart = 1,
  newStart = 1,
): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("\\")) {
      i += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({
        left: { text: "", kind: "empty", lineNo: null },
        right: { text: line.slice(1), kind: "add", lineNo: newNo },
      });
      newNo += 1;
      i += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      // Gather consecutive dels, then adds
      const dels: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.startsWith("-") && !l.startsWith("---")) {
          dels.push(l.slice(1));
          i += 1;
        } else break;
      }
      const adds: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.startsWith("+") && !l.startsWith("+++")) {
          adds.push(l.slice(1));
          i += 1;
        } else break;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          left:
            d !== undefined
              ? { text: d, kind: "del", lineNo: oldNo++ }
              : { text: "", kind: "empty", lineNo: null },
          right:
            a !== undefined
              ? { text: a, kind: "add", lineNo: newNo++ }
              : { text: "", kind: "empty", lineNo: null },
        });
      }
      continue;
    }
    // context (space or empty marker)
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      left: { text, kind: "ctx", lineNo: oldNo },
      right: { text, kind: "ctx", lineNo: newNo },
    });
    oldNo += 1;
    newNo += 1;
    i += 1;
  }

  return rows;
}

const HUNK_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunkStarts(header: string): { oldStart: number; newStart: number } {
  const m = HUNK_RE.exec(header);
  if (!m) return { oldStart: 1, newStart: 1 };
  return { oldStart: Number(m[1]), newStart: Number(m[3]) };
}
