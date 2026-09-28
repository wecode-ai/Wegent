import type { RootContent, PhrasingContent } from "mdast";
import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isHttpUrl } from "@wegent/chat-core/http-url";

const parser = unified().use(remarkParse).use(remarkGfm);

export function findComposerMarkdownLinks(value: string) {
  const links: {
    url: string;
    start: number;
    end: number;
    textStart: number;
    textEnd: number;
  }[] = [];
  const visit = (node: RootContent | PhrasingContent) => {
    if (node.type === "link" && isHttpUrl(node.url) && node.position) {
      const start = node.position.start.offset!;
      const end = node.position.end.offset!;
      const explicit = value[start] === "[";
      links.push({
        url: node.url,
        start,
        end,
        textStart: explicit
          ? (node.children[0]?.position?.start.offset ?? start)
          : start,
        // The editor maps a link's ending caret after its closing Markdown syntax.
        textEnd: end,
      });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  if (/https?:\/\//i.test(value)) parser.parse(value).children.forEach(visit);
  return links;
}

// Keep ordinary text and existing mention/link chips on their lossless text path.
export function parseComposerMarkdown(
  value: string,
  schema: Schema,
  plainDocument: (value: string, autolinks?: boolean) => PMNode,
): PMNode {
  const tree = parser.parse(value);
  const raw = (node: RootContent | PhrasingContent) =>
    value.slice(node.position?.start.offset, node.position?.end.offset);
  const isBareLink = (node: PhrasingContent) =>
    node.type === "link" && !/^[<[]/.test(raw(node));
  const inline = (
    nodes: PhrasingContent[],
    marks: readonly Mark[] = [],
  ): PMNode[] =>
    nodes.flatMap((node) => {
      const markName = (
        { strong: "strong", emphasis: "em", delete: "strike" } as Record<
          string,
          string
        >
      )[node.type];
      if (markName && "children" in node) {
        return inline(node.children as PhrasingContent[], [
          ...marks,
          schema.marks[markName].create(),
        ]);
      }
      if (node.type === "inlineCode")
        return node.value
          ? [schema.text(node.value, [...marks, schema.marks.code.create()])]
          : [];
      if (
        node.type === "break" ||
        (node.type === "html" && /^<br\s*\/?\s*>$/i.test(node.value))
      ) {
        return [schema.nodes.hard_break.create(null, null, marks)];
      }
      if (node.type === "link") {
        if (isBareLink(node)) {
          const content: PMNode[] = [];
          plainDocument(raw(node)).firstChild?.forEach((child) =>
            content.push(
              child.mark(
                child.isText
                  ? [
                      ...marks,
                      schema.marks.link.create({
                        href: node.url,
                        autolink: true,
                      }),
                    ]
                  : marks,
              ),
            ),
          );
          return content;
        }
        const chips = plainDocument(raw(node)).firstChild;
        if (
          chips?.childCount === 1 &&
          chips.firstChild?.isAtom &&
          !chips.firstChild.isText
        ) {
          return [chips.firstChild.mark(marks)];
        }
        return inline(node.children, [
          ...marks,
          schema.marks.link.create({ href: node.url, title: node.title }),
        ]);
      }
      const text = node.type === "text" ? node.value : raw(node);
      const result: PMNode[] = [];
      plainDocument(text).forEach((paragraph, _offset, index) => {
        if (index) result.push(schema.nodes.hard_break.create());
        paragraph.forEach((child) =>
          result.push(child.mark([...marks, ...child.marks])),
        );
      });
      return result;
    });
  const block = (node: RootContent): PMNode => {
    switch (node.type) {
      case "paragraph": {
        const content = inline(node.children);
        const trailing = value.slice(
          node.children.at(-1)?.position?.end.offset,
          node.position?.end.offset,
        );
        if (/^[ \t]+$/.test(trailing)) content.push(schema.text(trailing));
        return schema.node("paragraph", { markdown: true }, content);
      }
      case "heading":
        return schema.node(
          "heading",
          { level: node.depth },
          inline(node.children),
        );
      case "blockquote":
        return schema.node("blockquote", null, node.children.map(block));
      case "code":
        return schema.node(
          "code_block",
          { language: node.lang || "" },
          node.value ? schema.text(node.value) : undefined,
        );
      case "thematicBreak":
        return schema.node("horizontal_rule");
      case "list":
        return schema.node(
          node.ordered ? "ordered_list" : "bullet_list",
          { start: node.start ?? 1 },
          node.children.map(block),
        );
      case "listItem":
        return schema.node(
          "list_item",
          { checked: node.checked ?? null },
          node.children.map(block),
        );
      case "table":
        return schema.node(
          "table",
          null,
          node.children.map((row, index) =>
            schema.node(
              "table_row",
              null,
              row.children.map((cell, column) =>
                schema.node(
                  index === 0 ? "table_header" : "table_cell",
                  { align: node.align?.[column] ?? null },
                  schema.node(
                    "paragraph",
                    { markdown: true },
                    inline(cell.children),
                  ),
                ),
              ),
            ),
          ),
        );
      default:
        return schema.node(
          "paragraph",
          null,
          raw(node) ? schema.text(raw(node)) : undefined,
        );
    }
  };
  const rich = tree.children.some(
    (node) =>
      node.type !== "paragraph" ||
      node.children.some((child) => {
        if (child.type === "text") return false;
        if (child.type === "link") {
          if (isBareLink(child)) return false;
          const chip = plainDocument(raw(child)).firstChild?.firstChild;
          return !chip?.isAtom || chip.isText;
        }
        return true;
      }),
  );
  if (!rich) return plainDocument(value, true);
  const blocks = tree.children.map(block);
  if (blocks.at(-1)?.type.name !== "paragraph")
    blocks.push(schema.node("paragraph", { trailing: true }));
  return schema.node("doc", null, blocks);
}
