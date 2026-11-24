/** Built-in GitHub clone/download mirror prefixes (trailing slash optional). */
export const GITHUB_MIRROR_PRESETS: { id: string; label: string; prefix: string }[] =
  [
    { id: "off", label: "off", prefix: "" },
    {
      id: "ghproxy",
      label: "ghproxy.net",
      prefix: "https://ghproxy.net/",
    },
    {
      id: "ghproxy-mirror",
      label: "mirror.ghproxy.com",
      prefix: "https://mirror.ghproxy.com/",
    },
    {
      id: "gitclone",
      label: "gitclone.com",
      prefix: "https://gitclone.com/",
    },
  ];

/** Default hosts lines for GitHub (IPs change — user can edit). */
export const DEFAULT_GITHUB_HOSTS = `# qingzhi-github-hosts BEGIN
140.82.121.3 github.com
140.82.121.3 api.github.com
140.82.121.4 codeload.github.com
185.199.108.133 raw.githubusercontent.com
185.199.108.133 objects.githubusercontent.com
185.199.108.133 gist.githubusercontent.com
# qingzhi-github-hosts END
`;

/**
 * Rewrite https GitHub clone URLs through a mirror prefix when enabled.
 * Leaves SSH and non-GitHub URLs unchanged.
 */
export function applyGithubMirror(url: string, mirrorPrefix: string): string {
  const raw = url.trim();
  const prefix = mirrorPrefix.trim().replace(/\/?$/, "/");
  if (!prefix || prefix === "/") return raw;
  if (!/^https?:\/\//i.test(raw)) return raw;
  if (/gitclone\.com/i.test(raw) || /ghproxy/i.test(raw)) return raw;

  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (
      host !== "github.com" &&
      host !== "www.github.com" &&
      host !== "gist.github.com"
    ) {
      return raw;
    }
    // gitclone expects https://gitclone.com/github.com/owner/repo
    if (/gitclone\.com/i.test(prefix)) {
      const path = u.pathname.replace(/^\//, "");
      return `${prefix.replace(/\/?$/, "/")}${host}/${path}${u.search}`;
    }
    // ghproxy style: https://mirror/https://github.com/...
    return `${prefix}${raw}`;
  } catch {
    return raw;
  }
}
