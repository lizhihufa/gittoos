import type { FileChange } from "../types";

export type HeatNode = {
  name: string;
  path: string;
  count: number;
  children: HeatNode[];
};

/** Build a directory tree weighted by number of changed files under each folder. */
export function buildChangeHeatTree(files: FileChange[]): HeatNode {
  const root: HeatNode = { name: "", path: "", count: 0, children: [] };

  function ensure(parts: string[], full: string): HeatNode {
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: acc, count: 0, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.path = full;
    return node;
  }

  for (const f of files) {
    const norm = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const leaf = ensure(parts, norm);
    leaf.count += 1;
    // bubble counts
    let acc = "";
    let node = root;
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const child = node.children.find((c) => c.name === part);
      if (!child) break;
      if (child !== leaf) child.count += 1;
      node = child;
    }
    root.count += 1;
  }

  const sortRec = (n: HeatNode) => {
    n.children.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export function flattenHeat(
  node: HeatNode,
  depth = 0,
  out: { path: string; name: string; count: number; depth: number }[] = [],
): { path: string; name: string; count: number; depth: number }[] {
  if (node.name) {
    out.push({ path: node.path, name: node.name, count: node.count, depth });
  }
  for (const c of node.children) flattenHeat(c, depth + (node.name ? 1 : 0), out);
  return out;
}
