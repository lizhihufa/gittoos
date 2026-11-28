/** Extract [[Wiki]] links and build a simple adjacency list. */

export type WikiGraphEdge = { from: string; to: string };
export type WikiGraphNode = { id: string; links: number };

const LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export function extractWikiLinks(markdown: string): string[] {
  const out: string[] = [];
  const re = new RegExp(LINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const slug = m[1]!.trim().replace(/\s+/g, "-");
    if (slug && !slug.startsWith("_")) out.push(slug);
  }
  return out;
}

export function buildWikiGraph(
  pages: { slug: string; content?: string }[],
): { nodes: WikiGraphNode[]; edges: WikiGraphEdge[] } {
  const edges: WikiGraphEdge[] = [];
  const linkCount = new Map<string, number>();

  for (const p of pages) {
    linkCount.set(p.slug, linkCount.get(p.slug) ?? 0);
    if (!p.content) continue;
    for (const to of extractWikiLinks(p.content)) {
      edges.push({ from: p.slug, to });
      linkCount.set(p.slug, (linkCount.get(p.slug) ?? 0) + 1);
      linkCount.set(to, linkCount.get(to) ?? 0);
    }
  }

  const nodes = [...linkCount.entries()].map(([id, links]) => ({ id, links }));
  nodes.sort((a, b) => b.links - a.links || a.id.localeCompare(b.id));
  return { nodes, edges };
}
