import { AllSelection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { composerSchema } from './composerProseMirrorModel'

export function moveCaretAcrossComposerMention(view: EditorView, event: KeyboardEvent): boolean {
  if (
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !view.state.selection.empty
  ) {
    return false
  }

  const { $head } = view.state.selection
  if (event.key === 'ArrowLeft' && $head.pos === $head.start()) {
    return (
      $head.pos === TextSelection.atStart(view.state.doc).from &&
      setComposerSelection(view, event, $head.pos)
    )
  }
  if (event.key === 'ArrowRight' && $head.pos === $head.end()) {
    return (
      $head.pos === TextSelection.atEnd(view.state.doc).to &&
      setComposerSelection(view, event, $head.pos)
    )
  }
  if (
    event.key === 'ArrowLeft' &&
    $head.nodeBefore?.isText &&
    $head.nodeBefore.text?.endsWith(' ') &&
    view.state.doc.resolve($head.pos - 1).nodeBefore?.type === composerSchema.nodes.composer_mention
  ) {
    return setComposerSelection(view, event, $head.pos - 1)
  }

  const mentionBefore = $head.nodeBefore?.type === composerSchema.nodes.composer_mention
  const mentionAfter = $head.nodeAfter?.type === composerSchema.nodes.composer_mention

  if (event.key === 'ArrowLeft' && mentionAfter) {
    return setComposerSelection(view, event, Math.max($head.start(), $head.pos - 1))
  }
  if (event.key === 'ArrowRight' && mentionBefore) {
    return setComposerSelection(view, event, Math.min($head.end(), $head.pos + 1))
  }

  const adjacentNode = event.key === 'ArrowLeft' ? $head.nodeBefore : $head.nodeAfter
  if (
    adjacentNode?.type === composerSchema.nodes.composer_mention ||
    adjacentNode?.type === composerSchema.nodes.composer_link
  ) {
    const nextPosition =
      event.key === 'ArrowLeft'
        ? $head.pos - adjacentNode.nodeSize
        : $head.pos + adjacentNode.nodeSize
    return setComposerSelection(view, event, nextPosition)
  }

  const domAtom = findComposerAtomFromDOMSelection(view)
  if (!domAtom) return false
  const position = view.posAtDOM(domAtom, 0)
  return setComposerSelection(view, event, event.key === 'ArrowLeft' ? position : position + 1)
}

function findComposerAtomFromDOMSelection(view: EditorView): HTMLElement | null {
  const anchorNode = view.dom.ownerDocument.getSelection()?.anchorNode
  const anchorElement =
    anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null)
  const atom =
    anchorElement?.closest<HTMLElement>(
      '[data-composer-skill-reference], [data-composer-link-url]'
    ) ?? null
  return atom && view.dom.contains(atom) ? atom : null
}

function setComposerSelection(view: EditorView, event: KeyboardEvent, position: number): boolean {
  event.preventDefault()
  event.stopPropagation()
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)))
  view.focus()
  return true
}

export function moveComposerCaretToBoundary(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Home' && event.key !== 'End') return false

  const { selection } = view.state
  const { $head } = selection
  const target =
    event.metaKey || event.ctrlKey
      ? event.key === 'Home'
        ? TextSelection.atStart(view.state.doc).from
        : TextSelection.atEnd(view.state.doc).to
      : event.key === 'Home'
        ? $head.start()
        : $head.end()

  const nextSelection = event.shiftKey
    ? TextSelection.create(view.state.doc, selection.anchor, target)
    : TextSelection.create(view.state.doc, target)
  view.dispatch(view.state.tr.setSelection(nextSelection))
  view.focus()
  return true
}

export function selectAllComposerContent(view: EditorView, event: KeyboardEvent): boolean {
  if (
    event.key.toLowerCase() !== 'a' ||
    !event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey
  ) {
    return false
  }
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
  view.focus()
  return true
}
