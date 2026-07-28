import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import {
  composerSkillFilePath,
  createComposerMentionElement,
  type ComposerMentionPayload,
} from './composerMentions'

export class ComposerMentionNodeView implements NodeView {
  readonly dom: HTMLElement
  private node: ProseMirrorNode
  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly onOpenFile?: (path: string) => void

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    onOpenFile?: (path: string) => void
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.onOpenFile = onOpenFile
    this.dom = createComposerMentionElement(node.attrs as ComposerMentionPayload)
    this.dom.addEventListener('mousedown', this.handleMouseDown)
  }

  update(node: ProseMirrorNode): boolean {
    if (!node.sameMarkup(this.node)) return false
    this.node = node
    return true
  }

  stopEvent(event: Event): boolean {
    return event.type === 'mousedown'
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('mousedown', this.handleMouseDown)
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    const position = this.getPos()
    if (position === undefined) return

    event.preventDefault()
    event.stopPropagation()
    const filePath = composerSkillFilePath(String(this.node.attrs.reference ?? ''))
    if (filePath && this.onOpenFile) {
      this.onOpenFile(filePath)
      return
    }

    const bounds = this.dom.getBoundingClientRect()
    const nextPosition =
      event.clientX < bounds.left + bounds.width / 2 ? position : position + this.node.nodeSize
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, nextPosition))
    )
    this.view.focus()
  }
}
