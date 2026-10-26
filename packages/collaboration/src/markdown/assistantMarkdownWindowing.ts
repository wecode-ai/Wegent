import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

const STATIC_MARKDOWN_WINDOW_THRESHOLD = 4_000;
const STATIC_MARKDOWN_CHUNK_TARGET = 1_200;
const parser = unified().use(remarkParse);

/** Reference definitions belong to the full Markdown source, not one display chunk. */
export function hasMarkdownReferenceDefinitions(content: string): boolean {
  if (!content.includes("]:")) return false;
  const containsDefinition = (node: Root | RootContent): boolean =>
    node.type === "definition" ||
    ("children" in node && node.children.some(containsDefinition));
  return containsDefinition(parser.parse(content));
}

export function isOversizedAtomicMarkdownChunk(content: string): boolean {
  return content.length >= STATIC_MARKDOWN_WINDOW_THRESHOLD;
}

export function splitStaticMarkdownChunks(content: string): string[] {
  if (content.length < STATIC_MARKDOWN_WINDOW_THRESHOLD) return [content];

  const chunks: string[] = [];
  let current = "";
  let fenceMarker: "`" | "~" | null = null;
  for (const line of content.match(/.*(?:\n|$)/g) ?? []) {
    if (
      !fenceMarker &&
      /^#{1,3}\s/.test(line) &&
      current.length >= STATIC_MARKDOWN_CHUNK_TARGET
    ) {
      chunks.push(current);
      current = "";
    }
    current += line;
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence) continue;
    const marker = fence[1]?.[0];
    if (marker !== "`" && marker !== "~") continue;
    fenceMarker =
      fenceMarker === null
        ? marker
        : fenceMarker === marker
          ? null
          : fenceMarker;
  }
  if (current) chunks.push(current);
  return chunks.length > 1 ? chunks : [content];
}
