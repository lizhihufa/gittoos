import { describe, expect, it } from "vitest";
import {
  buildPartialHunkPatch,
  parseUnifiedDiff,
} from "./hunks";

const SAMPLE = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 line1
-old
+new1
+new2
 line3
`;

describe("parseUnifiedDiff", () => {
  it("parses preamble and hunks", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.preamble[0]).toContain("diff --git");
    expect(parsed!.hunks).toHaveLength(1);
    expect(parsed!.hunks[0]!.header).toMatch(/^@@/);
  });

  it("returns null without hunk headers", () => {
    expect(parseUnifiedDiff("not a diff")).toBeNull();
  });
});

describe("buildPartialHunkPatch", () => {
  const parsed = parseUnifiedDiff(SAMPLE)!;
  const hunk = parsed.hunks[0]!;
  // hunk.lines: " line1", "-old", "+new1", "+new2", " line3"

  it("returns null for empty selection", () => {
    expect(buildPartialHunkPatch(parsed.preamble, hunk, [])).toBeNull();
  });

  it("stages only selected addition", () => {
    const idx = hunk.lines.findIndex((l) => l === "+new1");
    const patch = buildPartialHunkPatch(parsed.preamble, hunk, [idx]);
    expect(patch).toContain("+new1");
    expect(patch).not.toContain("+new2");
    expect(patch).toContain(" old"); // unselected deletion → context
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("stages only selected deletion", () => {
    const idx = hunk.lines.findIndex((l) => l === "-old");
    const patch = buildPartialHunkPatch(parsed.preamble, hunk, [idx]);
    expect(patch).toContain("-old");
    expect(patch).not.toContain("+new1");
    expect(patch).not.toContain("+new2");
  });

  it("stages mixed selected lines", () => {
    const del = hunk.lines.findIndex((l) => l === "-old");
    const add = hunk.lines.findIndex((l) => l === "+new2");
    const patch = buildPartialHunkPatch(parsed.preamble, hunk, [del, add]);
    expect(patch).toContain("-old");
    expect(patch).toContain("+new2");
    expect(patch).not.toContain("+new1");
  });

  it("keeps no-newline marker after included line", () => {
    const text = `diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const p = parseUnifiedDiff(text)!;
    const h = p.hunks[0]!;
    const addIdx = h.lines.findIndex((l) => l === "+new");
    const patch = buildPartialHunkPatch(p.preamble, h, [addIdx]);
    expect(patch).toContain("+new");
    expect(patch).toContain("\\ No newline at end of file");
  });
});
