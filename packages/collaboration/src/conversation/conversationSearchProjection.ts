import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type {
  ConversationSearchRegion,
  ConversationSearchSource,
} from "@wegent/chat-core/conversation-search";
import { projectUnsupportedContentReferenceCitations } from "../markdown/assistantAnnotations";
import type { AssistantProseRegion } from "./assistantMessagePresentation";

const parser = unified().use(remarkParse).use(remarkGfm);
const BLOCK_TYPES = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
]);

/** Parse a complete render region once; AST spans retain its original item provenance. */
export function projectConversationSearchRegion(
  region: AssistantProseRegion,
  assistant = true,
): ConversationSearchRegion {
  const projection = assistant
    ? projectUnsupportedContentReferenceCitations(region.content, true)
    : {
        content: region.content,
        sources: [
          {
            start: 0,
            end: region.content.length,
            sourceStart: 0,
            sourceEnd: region.content.length,
          },
        ],
      };
  const source = projection.content;
  const result: ConversationSearchRegion = {
    id: region.id,
    text: "",
    sources: [],
  };
  const append = (value: string, node?: Root | RootContent) => {
    const start = result.text.length;
    result.text += value;
    if (!value || !node?.position) return;
    const nodeStart = node.position.start.offset ?? 0;
    const nodeEnd = node.position.end.offset ?? source.length;
    const raw = source.slice(nodeStart, nodeEnd);
    const literalOffset = raw.indexOf(value);
    const valueStart =
      literalOffset >= 0 ? nodeStart + literalOffset : nodeStart;
    const valueEnd = literalOffset >= 0 ? valueStart + value.length : nodeEnd;
    for (const retained of projection.sources) {
      const retainedStart = Math.max(retained.start, valueStart);
      const retainedEnd = Math.min(retained.end, valueEnd);
      if (retainedStart >= retainedEnd) continue;
      const rawStart = retained.sourceStart + retainedStart - retained.start;
      const rawEnd = retained.sourceStart + retainedEnd - retained.start;
      for (const part of region.sources) {
        const from = Math.max(part.start, rawStart);
        const to = Math.min(part.end, rawEnd);
        if (from >= to) continue;
        const sourceIsLiteral =
          part.end - part.start === part.sourceEnd - part.sourceStart;
        const direct = literalOffset >= 0 && sourceIsLiteral;
        const span: ConversationSearchSource = {
          itemId: part.itemId,
          start: direct
            ? start + retainedStart - valueStart + from - rawStart
            : start,
          end: direct
            ? start + retainedStart - valueStart + to - rawStart
            : start + value.length,
          sourceStart: sourceIsLiteral
            ? part.sourceStart + from - part.start
            : part.sourceStart,
          sourceEnd: sourceIsLiteral
            ? part.sourceStart + to - part.start
            : part.sourceEnd,
        };
        result.sources.push(span);
      }
    }
  };
  type Token = { value: string; node?: Root | RootContent };
  const tokens = (node: Root | RootContent): Token[] => {
    if (
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "html"
    )
      return [];
    if ("value" in node) return [{ value: node.value, node }];
    if (!("children" in node)) return [];
    const children = node.children
      .map((child) => tokens(child as RootContent))
      .filter((child) => child.some((token) => token.value));
    return children.flatMap((child, index) =>
      index && BLOCK_TYPES.has(node.type) ? [{ value: "\n" }, ...child] : child,
    );
  };
  for (const token of tokens(parser.parse(source)))
    append(token.value, token.node);
  return result;
}
