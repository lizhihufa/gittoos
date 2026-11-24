import { describe, expect, it } from "vitest";
import {
  buildResolvedContent,
  parseConflicts,
} from "./conflictParse";

describe("parseConflicts", () => {
  it("parses standard two-way markers", () => {
    const raw = `before
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> feature
after
`;
    const { segments, conflictCount } = parseConflicts(raw);
    expect(conflictCount).toBe(1);
    const c = segments.find((s) => s.kind === "conflict");
    expect(c).toMatchObject({
      kind: "conflict",
      oursLabel: "HEAD",
      theirsLabel: "feature",
      ours: "ours",
      theirs: "theirs",
      base: null,
    });
  });

  it("parses diff3 base markers", () => {
    const raw = `<<<<<<< ours
a
||||||| base
b
=======
c
>>>>>>> theirs
`;
    const { conflictCount, segments } = parseConflicts(raw);
    expect(conflictCount).toBe(1);
    const c = segments.find((s) => s.kind === "conflict")!;
    expect(c.kind).toBe("conflict");
    if (c.kind === "conflict") {
      expect(c.ours).toBe("a");
      expect(c.base).toBe("b");
      expect(c.theirs).toBe("c");
    }
  });

  it("does not crash on unclosed markers", () => {
    const raw = `<<<<<<< HEAD
only ours
`;
    const { conflictCount, segments } = parseConflicts(raw);
    expect(conflictCount).toBe(0);
    expect(segments.some((s) => s.kind === "text")).toBe(true);
  });
});

describe("buildResolvedContent", () => {
  it("returns null if any conflict unresolved", () => {
    const { segments } = parseConflicts(`<<<<<<< HEAD
a
=======
b
>>>>>>> x
`);
    expect(buildResolvedContent(segments, [null])).toBeNull();
  });

  it("builds file without conflict markers", () => {
    const { segments } = parseConflicts(`head
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> x
tail
`);
    const out = buildResolvedContent(segments, ["resolved"]);
    expect(out).toMatch(/^head\nresolved\ntail\n?$/);
    expect(out).not.toContain("<<<<<<<");
    expect(out).not.toContain("=======");
    expect(out).not.toContain(">>>>>>>");
  });
});
