import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
  type Node as ProseMirrorNode,
  type Slice,
} from "prosemirror-model";
import { composerSchema } from "./composerProseMirrorModel";

export function parseComposerClipboardHtml(html: string) {
  if (!html.trim() || html.length > 100000) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script,style,meta,link,iframe,object,embed")
    .forEach((node) => node.remove());
  document.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    if (/^\s*(?:javascript|data|vbscript):/i.test(href))
      link.removeAttribute("href");
  });
  const parsed = ProseMirrorDOMParser.fromSchema(composerSchema).parse(
    document.body,
  );
  let rich = parsed.childCount > 1;
  parsed.descendants((node) => {
    if (
      (node.isBlock && node.type.name !== "paragraph") ||
      node.marks.length > 0 ||
      (node.isInline && !node.isText)
    )
      rich = true;
  });
  const preserveLiteralText = (node: ProseMirrorNode): ProseMirrorNode => {
    if (node.isText) return node;
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(preserveLiteralText(child)));
    return node.type.create(
      node.type.name === "paragraph"
        ? { ...node.attrs, markdown: true }
        : node.attrs,
      children,
      node.marks,
    );
  };
  return rich ? preserveLiteralText(parsed) : null;
}

export function serializeComposerClipboardHtml(slice: Slice): string {
  const container = document.createElement("div");
  container.append(
    DOMSerializer.fromSchema(composerSchema).serializeFragment(slice.content),
  );
  return container.innerHTML;
}
