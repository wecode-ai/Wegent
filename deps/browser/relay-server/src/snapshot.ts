/**
 * Page Snapshot
 *
 * Generate AI-readable page structure for element interaction
 */

import { createBrowserClient } from "./browser-client.js";

export type RoleRef = {
  role: string;
  name?: string;
  nth?: number;
};

export type RoleRefMap = Record<string, RoleRef>;

export type SnapshotResult = {
  snapshot: string;
  refs: RoleRefMap;
  stats: {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
  };
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

const CONTENT_ROLES = new Set([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation",
]);

const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "list",
  "table",
  "row",
  "rowgroup",
  "grid",
  "treegrid",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "directory",
  "document",
  "application",
  "presentation",
  "none",
]);

type RawAXNode = {
  nodeId?: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
};

function axValue(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const value = (v as { value?: unknown }).value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export type AriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  depth: number;
  backendDOMNodeId?: number;
};

function formatAriaNodes(nodes: RawAXNode[], limit: number): AriaNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) byId.set(n.nodeId, n);
  }

  // Find root node
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) referenced.add(c);
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) return [];

  const out: AriaNode[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];

  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    if (!popped) break;
    const { id, depth } = popped;
    const n = byId.get(id);
    if (!n) continue;

    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `e${out.length + 1}`;

    out.push({
      ref,
      role: role || "unknown",
      name: name || "",
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    const children = (n.childIds ?? []).filter((c) => byId.has(c));
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ id: child, depth: depth + 1 });
    }
  }

  return out;
}

function buildSnapshotText(
  nodes: AriaNode[],
  opts: { interactive?: boolean; compact?: boolean; maxDepth?: number }
): SnapshotResult {
  const refs: RoleRefMap = {};
  const lines: string[] = [];
  const roleNameCounts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();

  const getKey = (role: string, name?: string) => `${role}:${name ?? ""}`;

  for (const node of nodes) {
    if (opts.maxDepth !== undefined && node.depth > opts.maxDepth) continue;

    const role = node.role.toLowerCase();
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role);
    const isStructural = STRUCTURAL_ROLES.has(role);

    if (opts.interactive && !isInteractive) continue;
    if (opts.compact && isStructural && !node.name) continue;

    const shouldHaveRef = isInteractive || (isContent && node.name);
    const indent = "  ".repeat(node.depth);

    if (shouldHaveRef) {
      const key = getKey(role, node.name);
      const count = roleNameCounts.get(key) ?? 0;
      roleNameCounts.set(key, count + 1);

      const existingRefs = refsByKey.get(key) ?? [];
      existingRefs.push(node.ref);
      refsByKey.set(key, existingRefs);

      refs[node.ref] = {
        role,
        ...(node.name ? { name: node.name } : {}),
        nth: count,
      };

      let line = `${indent}- ${node.role}`;
      if (node.name) line += ` "${node.name}"`;
      line += ` [ref=${node.ref}]`;
      if (count > 0) line += ` [nth=${count}]`;
      if (node.value) line += `: ${node.value}`;
      lines.push(line);
    } else {
      let line = `${indent}- ${node.role}`;
      if (node.name) line += ` "${node.name}"`;
      if (node.value) line += `: ${node.value}`;
      lines.push(line);
    }
  }

  // Remove nth from non-duplicates
  const duplicates = new Set<string>();
  for (const [key, refList] of refsByKey) {
    if (refList.length > 1) duplicates.add(key);
  }
  for (const [ref, data] of Object.entries(refs)) {
    const key = getKey(data.role, data.name);
    if (!duplicates.has(key)) {
      delete refs[ref]?.nth;
    }
  }

  const snapshot = lines.length ? lines.join("\n") : "(empty page)";
  const interactiveCount = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length;

  return {
    snapshot,
    refs,
    stats: {
      lines: lines.length,
      chars: snapshot.length,
      refs: Object.keys(refs).length,
      interactive: interactiveCount,
    },
  };
}

/**
 * Get page snapshot using Accessibility tree (via CDP)
 */
export async function getSnapshot(opts?: {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  limit?: number;
}): Promise<SnapshotResult> {
  const client = await createBrowserClient();
  try {
    const limit = Math.max(1, Math.min(2000, opts?.limit ?? 500));

    await client.send("Accessibility.enable", {});
    const res = (await client.send("Accessibility.getFullAXTree", {})) as { nodes?: RawAXNode[] };
    const rawNodes = Array.isArray(res?.nodes) ? res.nodes : [];
    const nodes = formatAriaNodes(rawNodes, limit);

    return buildSnapshotText(nodes, {
      interactive: opts?.interactive,
      compact: opts?.compact,
      maxDepth: opts?.maxDepth,
    });
  } finally {
    client.close();
  }
}

/**
 * Get DOM snapshot (alternative to Accessibility tree)
 */
export async function getDomSnapshot(opts?: {
  limit?: number;
  maxTextChars?: number;
}): Promise<{ nodes: DomNode[] }> {
  const client = await createBrowserClient();
  try {
    const limit = Math.max(1, Math.min(5000, opts?.limit ?? 800));
    const maxText = Math.max(0, Math.min(5000, opts?.maxTextChars ?? 220));

    await client.send("Runtime.enable", {});
    const result = (await client.send("Runtime.evaluate", {
      expression: `(() => {
        const maxNodes = ${limit};
        const maxText = ${maxText};
        const nodes = [];
        const root = document.documentElement;
        if (!root) return { nodes };
        const stack = [{ el: root, depth: 0, parentRef: null }];
        while (stack.length && nodes.length < maxNodes) {
          const cur = stack.pop();
          const el = cur.el;
          if (!el || el.nodeType !== 1) continue;
          const ref = "n" + String(nodes.length + 1);
          const tag = (el.tagName || "").toLowerCase();
          const id = el.id ? String(el.id) : undefined;
          const className = el.className ? String(el.className).slice(0, 300) : undefined;
          const role = el.getAttribute && el.getAttribute("role") ? String(el.getAttribute("role")) : undefined;
          const name = el.getAttribute && el.getAttribute("aria-label") ? String(el.getAttribute("aria-label")) : undefined;
          let text = "";
          try { text = String(el.innerText || "").trim(); } catch {}
          if (maxText && text.length > maxText) text = text.slice(0, maxText) + "...";
          const href = el.href ? String(el.href) : undefined;
          const type = el.type ? String(el.type) : undefined;
          const value = el.value !== undefined ? String(el.value).slice(0, 500) : undefined;
          nodes.push({
            ref,
            parentRef: cur.parentRef,
            depth: cur.depth,
            tag,
            ...(id ? { id } : {}),
            ...(className ? { className } : {}),
            ...(role ? { role } : {}),
            ...(name ? { name } : {}),
            ...(text ? { text } : {}),
            ...(href ? { href } : {}),
            ...(type ? { type } : {}),
            ...(value ? { value } : {}),
          });
          const children = el.children ? Array.from(el.children) : [];
          for (let i = children.length - 1; i >= 0; i--) {
            stack.push({ el: children[i], depth: cur.depth + 1, parentRef: ref });
          }
        }
        return { nodes };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: { nodes?: DomNode[] } } };

    return { nodes: result?.result?.value?.nodes ?? [] };
  } finally {
    client.close();
  }
}

export type DomNode = {
  ref: string;
  parentRef: string | null;
  depth: number;
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  name?: string;
  text?: string;
  href?: string;
  type?: string;
  value?: string;
};

// Store refs for action resolution
let currentRefs: RoleRefMap = {};

export function storeRefs(refs: RoleRefMap): void {
  currentRefs = refs;
}

export function getStoredRefs(): RoleRefMap {
  return currentRefs;
}

export function getRefInfo(ref: string): RoleRef | undefined {
  return currentRefs[ref];
}

/**
 * Parse ref string (supports "e1", "@e1", "ref=e1")
 */
export function parseRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("@")
    ? trimmed.slice(1)
    : trimmed.startsWith("ref=")
      ? trimmed.slice(4)
      : trimmed;
  return /^e\d+$/.test(normalized) ? normalized : null;
}
