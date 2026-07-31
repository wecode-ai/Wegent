import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { createComposerLinkElement, type ComposerLinkPayload } from './composerLinks'

export interface ComposerLinkNodeViewCallbacks {
  onOpenUrl?: (url: string) => void
  onEditLink?: (payload: ComposerLinkPayload, anchor?: HTMLElement) => void
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
  }

  update(node: ProseMirrorNode): boolean {
    if (!node.sameMarkup(this.node)) return false
    this.node = node
    const payload = node.attrs as ComposerLinkPayload
    const label = this.dom.querySelector('.composer-mention-label')
    if (label) label.textContent = payload.label
    this.dom.setAttribute('data-composer-link-url', payload.url)
    this.dom.setAttribute('aria-label', payload.label)
    return true
  }

  stopEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click'
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('mousedown', this.handleMouseDown)
    this.dom.removeEventListener('click', this.handleClick)
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
    this.callbacks.onEditLink?.(this.payload(), this.dom)
  }
}
