import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { createComposerLinkElement, type ComposerLinkPayload } from './composerLinks'
import { serializeComposerLinkNode, serializeComposerSlice } from './composerProseMirrorModel'

export interface ComposerLinkNodeViewCallbacks {
  onEditLink?: (
    payload: ComposerLinkPayload,
    anchor?: HTMLElement,
    range?: { start: number; end: number }
  ) => void
}

export class ComposerLinkNodeView implements NodeView {
  readonly dom: HTMLElement
  private node: ProseMirrorNode
  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly callbacks: ComposerLinkNodeViewCallbacks

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    callbacks: ComposerLinkNodeViewCallbacks
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.callbacks = callbacks
    this.dom = createComposerLinkElement(node.attrs as ComposerLinkPayload)
    this.dom.addEventListener('mousedown', this.handleMouseDown)
    this.dom.addEventListener('click', this.handleClick)
    this.dom.addEventListener('keydown', this.handleKeyDown)
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    const payload = node.attrs as ComposerLinkPayload
    const label = this.dom.querySelector('.composer-mention-label')
    if (label) label.textContent = payload.label
    this.dom.setAttribute('data-composer-link-url', payload.url)
    this.dom.setAttribute('data-composer-link-label', payload.label)
    this.dom.setAttribute('aria-label', payload.label)
    return true
  }

  stopEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click' || event.type === 'keydown'
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('mousedown', this.handleMouseDown)
    this.dom.removeEventListener('click', this.handleClick)
    this.dom.removeEventListener('keydown', this.handleKeyDown)
  }

  private readonly payload = (): ComposerLinkPayload => this.node.attrs as ComposerLinkPayload

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const position = this.getPos()
    if (position === undefined) return
    const bounds = this.dom.getBoundingClientRect()
    const nextPosition =
      event.clientX < bounds.left + bounds.width / 2 ? position : position + this.node.nodeSize
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, nextPosition))
    )
    this.view.focus()
  }

  private readonly handleClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const position = this.getPos()
    const range =
      position === undefined ? undefined : computeSerializedRange(this.view, position, this.node)
    this.callbacks.onEditLink?.(this.payload(), this.dom, range)
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    const position = this.getPos()
    const range =
      position === undefined ? undefined : computeSerializedRange(this.view, position, this.node)
    this.callbacks.onEditLink?.(this.payload(), this.dom, range)
  }
}

function computeSerializedRange(
  view: EditorView,
  position: number,
  node: ProseMirrorNode
): { start: number; end: number } {
  const before = serializeComposerSlice(view.state.doc.slice(0, position))
  const start = before.length
  return { start, end: start + serializeComposerLinkNode(node).length }
}
