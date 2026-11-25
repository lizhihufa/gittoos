/** Parse GitHub owner/repo from HTTPS, SSH, or owner/repo text. */
export function parseGithubOwnerRepo(
  input: string | null | undefined,
): { owner: string; repo: string } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const slash = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (slash) {
    // Bare owner/repo is ambiguous — treat as GitHub-style when no host hint.
    return { owner: slash[1], repo: slash[2] };
  }

  const https = raw.match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i,
  );
  if (https) {
    return { owner: https[1], repo: https[2] };
  }

  return null;
}

/** Parse Gitee owner/repo from HTTPS, SSH, or owner/repo text. */
export function parseGiteeOwnerRepo(
  input: string | null | undefined,
): { owner: string; repo: string } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const hosted = raw.match(
    /gitee\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i,
  );
  if (hosted) {
    return { owner: hosted[1], repo: hosted[2] };
  }

  // Bare owner/repo only when caller already knows it's Gitee (settings override).
  const slash = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (slash) {
    return { owner: slash[1], repo: slash[2] };
  }

  return null;
}

export function formatGithubOwnerRepo(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export const formatOwnerRepo = formatGithubOwnerRepo;
