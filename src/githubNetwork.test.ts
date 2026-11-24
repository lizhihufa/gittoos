import { describe, expect, it } from "vitest";
import { applyGithubMirror } from "./githubNetwork";

describe("applyGithubMirror", () => {
  it("leaves URL unchanged when mirror is empty", () => {
    expect(applyGithubMirror("https://github.com/a/b.git", "")).toBe(
      "https://github.com/a/b.git",
    );
  });

  it("rewrites via ghproxy prefix", () => {
    expect(
      applyGithubMirror(
        "https://github.com/a/b.git",
        "https://ghproxy.net/",
      ),
    ).toBe("https://ghproxy.net/https://github.com/a/b.git");
  });

  it("rewrites via gitclone host path style", () => {
    expect(
      applyGithubMirror(
        "https://github.com/a/b.git",
        "https://gitclone.com/",
      ),
    ).toBe("https://gitclone.com/github.com/a/b.git");
  });

  it("does not rewrite SSH or Gitee", () => {
    expect(
      applyGithubMirror("git@github.com:a/b.git", "https://ghproxy.net/"),
    ).toBe("git@github.com:a/b.git");
    expect(
      applyGithubMirror("https://gitee.com/a/b.git", "https://ghproxy.net/"),
    ).toBe("https://gitee.com/a/b.git");
  });
});
