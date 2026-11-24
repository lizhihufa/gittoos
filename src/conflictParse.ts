export type ConflictSegment =
  | { kind: "text"; text: string }
  | {
      kind: "conflict";
      oursLabel: string;
      theirsLabel: string;
      ours: string;
      theirs: string;
      base: string | null;
    };

const START = /^<<<<<<<(?:\s+(.*))?$/;
const BASE = /^\|\|\|\|\|\|\|(?:\s+(.*))?$/;
const MID = /^=======$/;
const END = /^>>>>>>>(?:\s+(.*))?$/;

/** Parse a worktree file that may contain Git conflict markers. */
export function parseConflicts(content: string): {
  segments: ConflictSegment[];
  conflictCount: number;
} {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const segments: ConflictSegment[] = [];
  let conflictCount = 0;
  let i = 0;
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length === 0) return;
    segments.push({ kind: "text", text: textBuf.join("\n") });
    textBuf = [];
  };

  while (i < lines.length) {
    const start = START.exec(lines[i] ?? "");
    if (!start) {
      textBuf.push(lines[i] ?? "");
      i += 1;
      continue;
    }

    flushText();
    const oursLabel = (start[1] ?? "HEAD").trim() || "HEAD";
    i += 1;
    const oursLines: string[] = [];
    const theirsLines: string[] = [];
    let baseLines: string[] | null = null;
    let mode: "ours" | "base" | "theirs" = "ours";
    let closed = false;

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (BASE.test(line) && mode === "ours") {
        baseLines = [];
        mode = "base";
        i += 1;
        continue;
      }
      if (MID.test(line) && (mode === "ours" || mode === "base")) {
        mode = "theirs";
        i += 1;
        continue;
      }
      const end = END.exec(line);
      if (end && mode === "theirs") {
        const theirsLabel = (end[1] ?? "incoming").trim() || "incoming";
        segments.push({
          kind: "conflict",
          oursLabel,
          theirsLabel,
          ours: oursLines.join("\n"),
          theirs: theirsLines.join("\n"),
          base: baseLines ? baseLines.join("\n") : null,
        });
        conflictCount += 1;
        closed = true;
        i += 1;
        break;
      }
      if (mode === "ours") oursLines.push(line);
      else if (mode === "base") baseLines!.push(line);
      else theirsLines.push(line);
      i += 1;
    }

    if (!closed) {
      textBuf.push(`<<<<<<< ${oursLabel}`);
      textBuf.push(...oursLines);
      if (baseLines) {
        textBuf.push("|||||||");
        textBuf.push(...baseLines);
      }
      if (mode === "theirs" || theirsLines.length > 0) {
        textBuf.push("=======");
        textBuf.push(...theirsLines);
      }
    }
  }

  flushText();
  return { segments, conflictCount };
}

/** Join resolved conflict + text segments back into file content. */
export function buildResolvedContent(
  segments: ConflictSegment[],
  resolutions: Array<string | null>,
): string | null {
  const parts: string[] = [];
  let conflictIdx = 0;
  for (const seg of segments) {
    if (seg.kind === "text") {
      parts.push(seg.text);
      continue;
    }
    const resolved = resolutions[conflictIdx];
    conflictIdx += 1;
    if (resolved === null || resolved === undefined) return null;
    parts.push(resolved);
  }
  if (parts.length === 0) return "";
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    out += `\n${parts[i] ?? ""}`;
  }
  return out;
}

export function bothSides(ours: string, theirs: string): string {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return `${ours}\n${theirs}`;
}
