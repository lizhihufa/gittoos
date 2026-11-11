/** Parse GitHub owner/repo from HTTPS, SSH, or owner/repo text. */
export function parseGithubOwnerRepo(
  input: string | null | undefined,
): { owner: string; repo: string } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const slash = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (slash) {
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

export function formatGithubOwnerRepo(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
