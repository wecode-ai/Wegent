import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import {
  parsePluginMentionReference,
  type PluginReference,
} from '@/features/plugins/pluginNavigation'
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
  private readonly onOpenPlugin?: (reference: PluginReference) => void

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    onOpenFile?: (path: string) => void,
    onOpenPlugin?: (reference: PluginReference) => void
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.onOpenFile = onOpenFile
    this.onOpenPlugin = onOpenPlugin
    this.dom = createComposerMentionElement(node.attrs as ComposerMentionPayload)
    this.dom.addEventListener('mousedown', this.handleMouseDown)
    this.dom.addEventListener('click', this.handleClick)
    this.dom.addEventListener('keydown', this.handleKeyDown)
  }

  update(node: ProseMirrorNode): boolean {
    if (!node.sameMarkup(this.node)) return false
    this.node = node
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

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    if (this.openFileMention()) return
    if (this.pluginReference() && this.onOpenPlugin) return

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
    if (!this.openPluginMention()) return

    event.preventDefault()
    event.stopPropagation()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (!this.openPluginMention()) return

    event.preventDefault()
    event.stopPropagation()
  }

  private openFileMention(): boolean {
    const reference = String(this.node.attrs.reference ?? '')
    const filePath = composerSkillFilePath(reference)
    if (filePath && this.onOpenFile) {
      this.onOpenFile(filePath)
      return true
    }
    return false
  }

  private pluginReference(): PluginReference | null {
    return parsePluginMentionReference(String(this.node.attrs.reference ?? ''))
  }

  private openPluginMention(): boolean {
    const pluginReference = this.pluginReference()
    if (pluginReference && this.onOpenPlugin) {
      this.onOpenPlugin(pluginReference)
      return true
    }

    return false
  }
}
