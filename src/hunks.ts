export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface ParsedDiff {
  /** File headers before the first @@ hunk (diff --git / --- / +++). */
  preamble: string[];
  hunks: DiffHunk[];
}

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
