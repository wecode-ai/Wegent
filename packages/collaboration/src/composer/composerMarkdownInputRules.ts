import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { setBlockType, wrapIn } from "prosemirror-commands";
import { closeHistory } from "prosemirror-history";
import {
  wrapInList,
  sinkListItem,
  liftListItem,
} from "prosemirror-schema-list";
import {
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { composerSchema } from "./composerProseMirrorModel";

function applyBlockRule(
  view: EditorView,
  transaction: Transaction,
  command: Command,
): boolean {
  const state = view.state.apply(transaction);
  return command(state, (result) => {
    result.steps.forEach((step) => transaction.step(step));
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        result.selection.anchor,
        result.selection.head,
      ),
    );
    view.dispatch(closeHistory(transaction).scrollIntoView());
  });
}

export function indentComposerList(direction: 1 | -1): Command {
  return direction === 1
    ? sinkListItem(composerSchema.nodes.list_item)
    : liftListItem(composerSchema.nodes.list_item);
}

export function composerMarkdownInputRules(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing || view.state.selection.$from.parent.type.spec.code)
          return false;
        const position = view.state.doc.resolve(from);
        if (!position.parent.isTextblock) return false;
        const prefix =
          position.parent.textBetween(
            0,
            position.parentOffset,
            undefined,
            "\uFFFC",
          ) + text;
        const transaction = view.state.tr.insertText(text, from, to);
        const start = position.start();
        let command: Command | undefined;
        if (/^\s{0,3}[-+*] $/.test(prefix))
          command = wrapInList(composerSchema.nodes.bullet_list);
        const ordered = /^\s{0,3}(\d+)\. $/.exec(prefix);
        if (ordered)
          command = wrapInList(composerSchema.nodes.ordered_list, {
            start: Number(ordered[1]),
          });
        const heading = /^(#{1,6}) $/.exec(prefix);
        if (heading)
          command = setBlockType(composerSchema.nodes.heading, {
            level: heading[1].length,
          });
        if (/^> $/.test(prefix))
          command = wrapIn(composerSchema.nodes.blockquote);
        const code = /^```([\w+-]*) $/.exec(prefix);
        if (code)
          command = setBlockType(composerSchema.nodes.code_block, {
            language: code[1],
          });
        if (command)
          return applyBlockRule(
            view,
            transaction.delete(start, from + text.length),
            command,
          );

        const rules = [
          {
            pattern: /(?:^|\s)(\*\*([^*]+)\*\*)$/,
            mark: "strong",
            delimiter: 2,
          },
          { pattern: /(?:^|\s)(__([^_]+)__)$/, mark: "strong", delimiter: 2 },
          { pattern: /(?:^|\s)(\*([^*]+)\*)$/, mark: "em", delimiter: 1 },
          { pattern: /(?:^|\s)(_([^_]+)_)$/, mark: "em", delimiter: 1 },
          { pattern: /(?:^|\s)(~~([^~]+)~~)$/, mark: "strike", delimiter: 2 },
          { pattern: /(?:^|\s)(`([^`]+)`)$/, mark: "code", delimiter: 1 },
        ];
        for (const { pattern, mark, delimiter } of rules) {
          const match = pattern.exec(prefix);
          if (!match) continue;
          const end = from + text.length;
          const begin = end - match[1].length;
          transaction
            .delete(end - delimiter, end)
            .delete(begin, begin + delimiter);
          transaction.addMark(
            begin,
            begin + match[2].length,
            composerSchema.marks[mark].create(),
          );
          transaction.removeStoredMark(composerSchema.marks[mark]);
          view.dispatch(closeHistory(transaction).scrollIntoView());
          return true;
        }
        return false;
      },
    },
  });
}

function typedTableCells(node: ProseMirrorNode) {
  const value = node.textContent;
  if (!/^\s*\|[\s\S]*\|\s*$/.test(value)) return null;
  let onlyText = true;
  node.forEach((child) => {
    if (!child.isText) onlyText = false;
  });
  if (!onlyText) return null;
  const parts: { text: string; content: Fragment }[] = [];
  let start = value.indexOf("|") + 1;
  for (let index = start; index <= value.lastIndexOf("|"); index++) {
    if (value[index] === "\\" && value[index + 1] === "|") {
      index++;
      continue;
    }
    if (value[index] !== "|") continue;
    let from = start,
      to = index;
    while (from < to && /\s/.test(value[from])) from++;
    while (to > from && /\s/.test(value[to - 1])) to--;
    let content = Fragment.empty;
    let cursor = from;
    for (let position = from; position < to; position++) {
      if (value[position] !== "\\" || value[position + 1] !== "|") continue;
      content = content.append(node.content.cut(cursor, position));
      cursor = position + 1;
      position++;
    }
    content = content.append(node.content.cut(cursor, to));
    parts.push({ text: value.slice(from, to), content });
    start = index + 1;
  }
  return parts.length >= 2 ? parts : null;
}

export function convertTypedComposerTable(view: EditorView): boolean {
  const { $from, empty } = view.state.selection;
  if (
    view.composing ||
    !empty ||
    $from.depth !== 1 ||
    $from.parentOffset !== $from.parent.content.size
  )
    return false;
  const index = $from.index(0);
  if (index < 2) return false;
  const lines = [index - 2, index - 1, index].map((i) =>
    view.state.doc.child(i),
  );
  if (lines.some((line) => line.type !== composerSchema.nodes.paragraph))
    return false;
  const [header, separator, body] = lines.map(typedTableCells);
  if (
    !header ||
    !separator ||
    !body ||
    header.length !== separator.length ||
    header.length !== body.length ||
    separator.some((cell) => !/^:?-{3,}:?$/.test(cell.text))
  )
    return false;
  const table = composerSchema.nodes.table.create(
    null,
    [header, body].map((row, rowIndex) =>
      composerSchema.nodes.table_row.create(
        null,
        row.map((cell, column) => {
          const marker = separator[column].text;
          const align = marker.startsWith(":")
            ? marker.endsWith(":")
              ? "center"
              : "left"
            : marker.endsWith(":")
              ? "right"
              : null;
          return composerSchema.nodes[
            rowIndex === 0 ? "table_header" : "table_cell"
          ].create(
            { align },
            composerSchema.nodes.paragraph.create(
              { markdown: true },
              cell.content,
            ),
          );
        }),
      ),
    ),
  );
  const start = $from.before() - lines[0].nodeSize - lines[1].nodeSize;
  const transaction = view.state.tr.replaceWith(start, $from.after(), [
    table,
    composerSchema.nodes.paragraph.create(),
  ]);
  transaction.setSelection(
    TextSelection.create(transaction.doc, start + table.nodeSize + 1),
  );
  view.dispatch(closeHistory(transaction).scrollIntoView());
  return true;
}
