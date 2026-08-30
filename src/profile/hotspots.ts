import type { PlanNode } from "./parse.js";

/** Sum of exec time over a node's subtree (ns). */
export function subtreeExecNs(node: PlanNode): number {
  const own = node.stats?.phaseTimes?.exec ?? 0;
  return own + node.children.reduce((s, c) => s + subtreeExecNs(c), 0);
}

export interface AnnotatedNode {
  node: PlanNode;
  depth: number;
  execNs: number;
  /** exec as a fraction of the whole plan's subtree exec (0–1). */
  fraction: number;
  /** exec ≥ 50% of plan-total — Edge Studio's hotspot threshold. */
  isHotspot: boolean;
}

export const HOTSPOT_THRESHOLD = 0.5;

/** Flatten the plan tree depth-first with exec fractions + hotspot flags. */
export function annotatePlan(root: PlanNode): AnnotatedNode[] {
  const total = subtreeExecNs(root);
  const out: AnnotatedNode[] = [];
  const walk = (node: PlanNode, depth: number) => {
    const execNs = node.stats?.phaseTimes?.exec ?? 0;
    const fraction = total > 0 ? execNs / total : 0;
    out.push({ node, depth, execNs, fraction, isHotspot: fraction >= HOTSPOT_THRESHOLD && execNs > 0 });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** The single most useful operator attribute for compact display, if any. */
export function keyAttribute(node: PlanNode): string | undefined {
  const priority = ["collection", "alias", "limit", "field", "table", "index", "condition"];
  for (const key of priority) {
    const hit = node.attributes.find(([k]) => k === key);
    if (hit) {
      const v = typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1]);
      return `${key}=${v}`;
    }
  }
  return undefined;
}
