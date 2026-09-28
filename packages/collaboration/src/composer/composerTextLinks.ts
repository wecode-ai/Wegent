import { Plugin, PluginKey } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { findComposerMarkdownLinks } from "./composerMarkdownParser";
import {
  positionFromSerializedOffset,
  serializeMarkdownDocument,
} from "./composerMarkdownSerializer";
import type { ComposerLinkNodeViewCallbacks } from "./ComposerLinkNodeView";

const linkKey = new PluginKey<ReturnType<typeof buildTextLinks>>(
  "composer-text-links",
);
type OpenLink = NonNullable<ComposerLinkNodeViewCallbacks["onEditLink"]>;

function buildTextLinks(doc: PMNode) {
  const source = serializeMarkdownDocument(doc).text;
  const links = findComposerMarkdownLinks(source).flatMap((link) => {
    const from = positionFromSerializedOffset(doc, link.textStart);
    const to = positionFromSerializedOffset(doc, link.textEnd);
    if (from >= to) return [];
    let atomic = false;
    doc.nodesBetween(from, to, (node) => {
      if (node.isInline && !node.isText) atomic = true;
    });
    if (atomic) return [];
    return [{ ...link, from, to, label: doc.textBetween(from, to) }];
  });
  const decorations = DecorationSet.create(
    doc,
    links.map((link) =>
      Decoration.inline(link.from, link.to, {
        nodeName: "span",
        class: 'composer-text-link cursor-pointer',
        role: "link",
        tabindex: "0",
        "data-testid": "composer-text-link",
        "data-composer-text-link": String(link.start),
        "aria-label": link.url,
      }),
    ),
  );
  return { links, decorations };
}

export function openComposerTextLink(
  view: EditorView,
  event: MouseEvent | KeyboardEvent,
  onOpen: OpenLink,
): boolean {
  if (!(event.target instanceof Element)) return false;
  const anchor = event.target.closest<HTMLElement>("[data-composer-text-link]");
  if (!anchor || !view.dom.contains(anchor)) return false;
  if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key))
    return false;
  if (
    event instanceof MouseEvent &&
    (event.button !== 0 || event.detail > 1 || !view.state.selection.empty)
  )
    return false;
  const link = linkKey
    .getState(view.state)
    ?.links.find(
      (link) => String(link.start) === anchor.dataset.composerTextLink,
    );
  if (!link) return false;
  event.preventDefault();
  event.stopPropagation();
  onOpen(
    { url: link.url, label: link.label, iconUrl: "", provider: "" },
    anchor,
    {
      start: link.start,
      end: link.end,
    },
  );
  return true;
}

export function composerTextLinks(onOpen: OpenLink): Plugin {
  return new Plugin({
    key: linkKey,
    state: {
      init: (_, state) => buildTextLinks(state.doc),
      apply: (transaction, previous) =>
        transaction.docChanged ? buildTextLinks(transaction.doc) : previous,
    },
    props: {
      decorations: (state) => linkKey.getState(state)?.decorations,
      handleDOMEvents: {
        click: (view, event) => openComposerTextLink(view, event, onOpen),
      },
    },
  });
}
