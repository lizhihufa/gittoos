import type { CommitInfo } from "./types";

export interface GraphRow {
  commit: CommitInfo;
  /** Lane index of this commit's node (0-based). */
  lane: number;
  /** Active lane indexes that draw a vertical line through this row. */
  through: number[];
  /** Max lane count in this row (for column width). */
  width: number;
}

/** Assign commit lanes for a simple left-to-right branch graph. */
export function layoutCommitGraph(commits: CommitInfo[]): GraphRow[] {
  const rows: GraphRow[] = [];
  // lane -> hash we expect next (walking from tip toward roots)
  const lanes: (string | null)[] = [];

  for (const commit of commits) {
    let lane = lanes.findIndex((h) => h === commit.hash);
    if (lane < 0) {
      lane = lanes.findIndex((h) => h === null);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(commit.hash);
      } else {
        lanes[lane] = commit.hash;
      }
    }

    const parents = commit.parents
      ? commit.parents.split(" ").filter(Boolean)
      : [];
    const first = parents[0];
    const rest = parents.slice(1);

    lanes[lane] = first ?? null;

    for (const parent of rest) {
      let free = lanes.findIndex((h) => h === null);
      if (free < 0) {
        free = lanes.length;
        lanes.push(parent);
      } else {
        lanes[free] = parent;
      }
    }

    // Drop trailing empty lanes for compact width.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    const through: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null || i === lane) through.push(i);
    }

    rows.push({
      commit,
      lane,
      through,
      width: Math.max(lanes.length, lane + 1, 1),
    });
  }

  return rows;
}

export function parseRefBadges(refs: string | undefined): string[] {
  if (!refs) return [];
  const inner = refs.replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^HEAD\s*->\s*/, "HEAD → ").replace(/^tag:\s*/, "tag:"));
}
