import { chainCommands, splitBlock } from "prosemirror-commands";
import { liftListItem, splitListItem } from "prosemirror-schema-list";
import { Plugin, TextSelection, type Command } from "prosemirror-state";
import { goToNextCell, isInTable } from "prosemirror-tables";
import { composerSchema } from "./composerProseMirrorModel";

export const insertComposerLineBreak: Command = (state, dispatch, view) => {
  if (state.selection.$from.parent.type.spec.code) {
    dispatch?.(state.tr.insertText("\n").scrollIntoView());
    return true;
  }
  if (isInTable(state)) {
    dispatch?.(
      state.tr
        .replaceSelectionWith(composerSchema.nodes.hard_break.create())
        .scrollIntoView(),
    );
    return true;
  }
  return chainCommands(
    splitListItem(composerSchema.nodes.list_item),
    liftListItem(composerSchema.nodes.list_item),
    splitBlock,
  )(state, dispatch, view);
};

export function moveComposerTableCell(direction: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    if (goToNextCell(direction)(state, dispatch, view)) return true;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name !== "table") continue;
      const position =
        direction === 1 ? $from.after(depth) : $from.before(depth);
      dispatch?.(
        state.tr
          .setSelection(
            TextSelection.near(state.doc.resolve(position), direction),
          )
          .scrollIntoView(),
      );
      return true;
    }
    return false;
  };
}

// A final text position lets the user leave a table/code block with the keyboard.
export const trailingComposerParagraph = new Plugin({
  appendTransaction(transactions, _oldState, state) {
    if (!transactions.some((transaction) => transaction.docChanged))
      return null;
    const transaction = state.tr;
    const lastPosition =
      state.doc.content.size - (state.doc.lastChild?.nodeSize ?? 0);
    state.doc.forEach((node, position) => {
      if (
        node.type === composerSchema.nodes.paragraph &&
        node.attrs.trailing &&
        (node.content.size > 0 || position !== lastPosition)
      ) {
        transaction.setNodeMarkup(position, undefined, {
          ...node.attrs,
          trailing: false,
        });
      }
    });
    if (transaction.doc.lastChild?.type !== composerSchema.nodes.paragraph) {
      transaction.insert(
        transaction.doc.content.size,
        composerSchema.nodes.paragraph.create({ trailing: true }),
      );
    }
    return transaction.docChanged ? transaction : null;
  },
});
