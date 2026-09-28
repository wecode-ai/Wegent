import type { Root, RootContent } from "hast";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

declare module "hast" {
  interface ElementData {
    tableMarkdown?: string;
  }
}

function preserveTableMarkdown({
  restoreLinks,
}: {
  restoreLinks: (source: string) => string;
}) {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Root | RootContent) => {
      if (node.type === "element" && node.tagName === "table") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          node.data = {
            ...node.data,
            tableMarkdown: restoreLinks(source.slice(start, end)),
          };
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

export function createTableMarkdownRehypePlugins(
  restoreLinks: (source: string) => string,
): StreamdownProps["rehypePlugins"] {
  return [
    ...Object.values(defaultRehypePlugins),
    [preserveTableMarkdown, { restoreLinks }],
  ];
}
