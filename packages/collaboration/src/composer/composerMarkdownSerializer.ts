import type { Fragment, Mark, Node as PMNode } from "prosemirror-model";
import { serializeComposerLink } from "./composerLinks";

interface SerializedDocument {
  text: string;
  positions: Map<number, number>;
  textblockPositions?: [number, number][];
}

const cache = new WeakMap<PMNode, SerializedDocument>();

// Bare URLs stay lossless until neighboring text needs an explicit link boundary.
function inlineMarks(fragment: Fragment, index: number): readonly Mark[] {
  return fragment
    .child(index)
    .marks.filter((mark) => mark.type.name !== "composer_mention_separator")
    .map((mark) => {
      if (mark.type.name !== "link" || !mark.attrs.autolink) return mark;
      let from = index;
      let to = index + 1;
      while (from > 0 && mark.isInSet(fragment.child(from - 1).marks)) from--;
      while (to < fragment.childCount && mark.isInSet(fragment.child(to).marks))
        to++;
      let label = "";
      for (let i = from; i < to; i++) label += fragment.child(i).textContent;
      const before = from > 0 ? fragment.child(from - 1).textContent : "";
      const after =
        to < fragment.childCount ? fragment.child(to).textContent : "";
      return /\S$/.test(before) ||
        /^\S/.test(after) ||
        label !== mark.attrs.href
        ? mark.type.create({ ...mark.attrs, autolink: false })
        : mark;
    });
}

export function serializeMarkdownDocument(doc: PMNode): SerializedDocument {
  const cached = cache.get(doc);
  if (cached) return cached;
  const writer = new MarkdownWriter();
  writer.blocks(doc.content, 0);
  writer.positions.set(0, 0);
  writer.positions.set(doc.content.size, writer.text.length);
  const result = { text: writer.text, positions: writer.positions };
  cache.set(doc, result);
  return result;
}

export function serializeMarkdownFragment(fragment: Fragment): string {
  const writer = new MarkdownWriter();
  writer.blocks(fragment, 0);
  return writer.text;
}

export function serializedOffsetFromPosition(
  doc: PMNode,
  position: number,
): number {
  const result = serializeMarkdownDocument(doc);
  return result.positions.get(position) ?? 0;
}

export function positionFromSerializedOffset(
  doc: PMNode,
  offset: number,
): number {
  const serializedDocument = serializeMarkdownDocument(doc);
  const { positions } = serializedDocument;
  const textblockPositions = (serializedDocument.textblockPositions ??=
    Array.from(positions).filter(
      ([position]) => doc.resolve(position).parent.isTextblock,
    ));
  let result = 1;
  let distance = Infinity;
  for (const [position, serialized] of textblockPositions) {
    const current = Math.abs(serialized - offset);
    // Atomic references snap forward; normal text positions map exactly.
    if (current < distance || (serialized >= offset && current === distance)) {
      result = position;
      distance = current;
    }
  }
  // Offsets inside an atomic reference belong to its end, never its label.
  doc.descendants((node, position) => {
    if (!node.isInline || !node.isAtom || node.isText) return true;
    const start = positions.get(position);
    const end = positions.get(position + node.nodeSize);
    if (
      start !== undefined &&
      end !== undefined &&
      offset > start &&
      offset < end
    ) {
      result = position + node.nodeSize;
    }
    return false;
  });
  return result;
}

class MarkdownWriter {
  text = "";
  positions = new Map<number, number>();
  prefix = "";

  emit(value: string) {
    for (const character of value) {
      if (this.text.endsWith("\n") && character !== "\n")
        this.text += this.prefix;
      this.text += character;
    }
  }

  at(position: number) {
    this.positions.set(position, this.text.length);
  }

  blocks(fragment: Fragment, start: number, inCell = false) {
    let previous: PMNode | undefined;
    fragment.forEach((node, offset) => {
      if (node.attrs.trailing && node.content.size === 0) {
        this.at(start + offset + 1);
        return;
      }
      if (previous) {
        this.emit(
          inCell
            ? "<br>"
            : previous.type.name === "paragraph" &&
                node.type.name === "paragraph" &&
                !previous.attrs.markdown &&
                !node.attrs.markdown
              ? "\n"
              : "\n\n",
        );
      }
      this.block(node, start + offset, inCell);
      previous = node;
    });
  }

  block(node: PMNode, position: number, inCell = false) {
    this.at(position);
    switch (node.type.name) {
      case "paragraph":
      case "heading":
        if (node.type.name === "heading")
          this.emit(`${"#".repeat(node.attrs.level)} `);
        this.inline(
          node.content,
          position + 1,
          inCell,
          Boolean(node.attrs.markdown) || node.type.name === "heading",
        );
        break;
      case "code_block": {
        const fence = "`".repeat(
          Math.max(
            3,
            ...Array.from(
              node.textContent.matchAll(/`+/g),
              (match) => match[0].length + 1,
            ),
          ),
        );
        this.emit(`${fence}${node.attrs.language}\n`);
        this.literal(node.textContent, position + 1);
        this.emit(`\n${fence}`);
        break;
      }
      case "blockquote": {
        this.emit("> ");
        const prefix = this.prefix;
        this.prefix += "> ";
        this.blocks(node.content, position + 1);
        this.prefix = prefix;
        break;
      }
      case "bullet_list":
      case "ordered_list":
        node.forEach((item, offset, index) => {
          if (index) this.emit("\n");
          this.at(position + 1 + offset);
          const marker =
            node.type.name === "ordered_list"
              ? `${Number(node.attrs.start) + index}. `
              : "- ";
          this.emit(marker);
          if (item.attrs.checked !== null)
            this.emit(item.attrs.checked ? "[x] " : "[ ] ");
          const prefix = this.prefix;
          this.prefix += " ".repeat(marker.length);
          this.blocks(item.content, position + 2 + offset);
          this.prefix = prefix;
        });
        break;
      case "table":
        node.forEach((row, offset, index) => {
          if (index) this.emit("\n");
          this.emit("| ");
          row.forEach((cell, cellOffset, column) => {
            if (column) this.emit(" | ");
            this.blocks(cell.content, position + offset + cellOffset + 3, true);
          });
          this.emit(" |");
          if (index === 0) {
            this.emit("\n| ");
            row.forEach((cell, _offset, column) => {
              if (column) this.emit(" | ");
              const alignment = cell.attrs.align;
              this.emit(
                alignment === "center"
                  ? ":---:"
                  : alignment === "left"
                    ? ":---"
                    : alignment === "right"
                      ? "---:"
                      : "---",
              );
            });
            this.emit(" |");
          }
        });
        break;
      case "horizontal_rule":
        this.emit("---");
        break;
      default:
        if (node.isInline) this.inlineNode(node, position, inCell, false);
        else this.blocks(node.content, position + 1, inCell);
    }
    this.at(position + node.nodeSize);
  }

  inline(fragment: Fragment, start: number, inCell: boolean, escape: boolean) {
    let active: readonly Mark[] = [];
    this.at(start);
    fragment.forEach((node, offset, index) => {
      const marks = inlineMarks(fragment, index);
      let shared = 0;
      while (
        shared < active.length &&
        shared < marks.length &&
        active[shared].eq(marks[shared])
      )
        shared++;
      for (let index = active.length - 1; index >= shared; index--)
        this.mark(active[index], false, node);
      for (let index = shared; index < marks.length; index++)
        this.mark(marks[index], true, node);
      active = marks;
      this.inlineNode(node.mark(marks), start + offset, inCell, escape);
    });
    for (let index = active.length - 1; index >= 0; index--)
      this.mark(active[index], false);
    this.at(start + fragment.size);
  }

  private codeFence = "`";
  private codePadding = "";

  mark(mark: Mark, open: boolean, node?: PMNode) {
    switch (mark.type.name) {
      case "strong":
        this.emit("**");
        break;
      case "em":
        this.emit("*");
        break;
      case "strike":
        this.emit("~~");
        break;
      case "code":
        if (open) {
          const text = node?.text || "";
          this.codeFence = "`".repeat(
            Math.max(
              1,
              ...Array.from(
                text.matchAll(/`+/g),
                (match) => match[0].length + 1,
              ),
            ),
          );
          this.codePadding = /^`|`$|^ .+ $/.test(text) ? " " : "";
        }
        this.emit(
          open
            ? this.codeFence + this.codePadding
            : this.codePadding + this.codeFence,
        );
        break;
      case "link":
        if (mark.attrs.autolink) break;
        this.emit(
          open
            ? "["
            : `](${mark.attrs.href}${mark.attrs.title ? ` "${String(mark.attrs.title).replaceAll('"', '\\"')}"` : ""})`,
        );
        break;
    }
  }

  inlineNode(node: PMNode, position: number, inCell: boolean, escape: boolean) {
    this.at(position);
    if (node.isText) {
      const literal = node.marks.some(
        (mark) => mark.type.name === "code" || mark.attrs.autolink,
      );
      const value = node.text || "";
      for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (
          (inCell && character === "|") ||
          ((escape || node.marks.some((mark) => mark.type.name === "link")) &&
            !literal &&
            /[\\`*_[\]<>~]/.test(character))
        )
          this.emit("\\");
        this.emit(character === "\n" && inCell ? "<br>" : character);
        this.at(position + index + 1);
      }
    } else if (node.type.name === "composer_mention") {
      this.emit(String(node.attrs.reference));
    } else if (node.type.name === "composer_link") {
      this.emit(
        serializeComposerLink({
          label: String(node.attrs.label ?? ""),
          url: String(node.attrs.url),
        }),
      );
    } else if (node.type.name === "hard_break")
      this.emit(inCell ? "<br>" : "\n");
    this.at(position + node.nodeSize);
  }

  literal(value: string, start: number) {
    this.at(start);
    for (let index = 0; index < value.length; index++) {
      this.emit(value[index]);
      this.at(start + index + 1);
    }
  }
}
