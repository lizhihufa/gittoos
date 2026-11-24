export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface ParsedDiff {
  /** File headers before the first @@ hunk (diff --git / --- / +++). */
  preamble: string[];
  hunks: DiffHunk[];
}

const HUNK_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string): ParsedDiff | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((l) => l.startsWith("@@"))) return null;

  const preamble: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.length > 0) preamble.push(line);
      continue;
    }
    current.lines.push(line);
  }

  if (hunks.length === 0 || preamble.length === 0) return null;
  return { preamble, hunks };
}

export function buildHunkPatch(preamble: string[], hunk: DiffHunk): string {
  const body = [hunk.header, ...hunk.lines].join("\n");
  const head = preamble.join("\n");
  return `${head}\n${body}\n`;
}

export function isChangeLine(line: string): boolean {
  if (line.startsWith("+") && !line.startsWith("+++")) return true;
  if (line.startsWith("-") && !line.startsWith("---")) return true;
  return false;
}

function parseHunkHeader(header: string): {
  oldStart: number;
  newStart: number;
  suffix: string;
} | null {
  const m = HUNK_RE.exec(header);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    newStart: Number(m[3]),
    suffix: m[5] ?? "",
  };
}

/**
 * Build a patch containing only the selected change lines inside one hunk.
 * Used for stage / unstage / discard; callers choose `--cached` / `--reverse`.
 *
 * - Selected `+` / `-`: kept as changes
 * - Unselected `+`: omitted (stay out of this apply)
 * - Unselected `-`: turned into context (line remains on the "before" side)
 */
export function buildPartialHunkPatch(
  preamble: string[],
  hunk: DiffHunk,
  selectedIndices: Iterable<number>,
): string | null {
  const selected = new Set(selectedIndices);
  let hasChange = false;
  for (const i of selected) {
    const line = hunk.lines[i];
    if (line && isChangeLine(line)) {
      hasChange = true;
      break;
    }
  }
  if (!hasChange) return null;

  const parsed = parseHunkHeader(hunk.header);
  if (!parsed) return null;

  const out: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    if (line.startsWith("\\")) {
      // Keep "\ No newline…" only when it follows an included content line.
      if (out.length > 0) out.push(line);
      continue;
    }

    const kind = line[0];
    const picked = selected.has(i);

    if (kind === " " || line === "") {
      out.push(line.startsWith(" ") ? line : ` ${line}`);
      oldCount += 1;
      newCount += 1;
      continue;
    }

    if (kind === "+" && !line.startsWith("+++")) {
      if (picked) {
        out.push(line);
        newCount += 1;
      }
      // Unselected addition: omit from patch.
      continue;
    }

    if (kind === "-" && !line.startsWith("---")) {
      if (picked) {
        out.push(line);
        oldCount += 1;
      } else {
        // Keep the line in the before-side as context.
        out.push(` ${line.slice(1)}`);
        oldCount += 1;
        newCount += 1;
      }
      continue;
    }

    // Unknown marker — keep as context-ish so apply has a chance.
    out.push(line);
  }

  if (oldCount === 0 && newCount === 0) return null;

  const header = `@@ -${parsed.oldStart},${oldCount} +${parsed.newStart},${newCount} @@${parsed.suffix}`;
  const body = [header, ...out].join("\n");
  return `${preamble.join("\n")}\n${body}\n`;
}
