import { Package } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  DOMConversionMap,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { $applyNodeReplacement, DecoratorNode } from 'lexical'

export interface ComposerSkillPayload {
  name: string
  label: string
  reference: string
}

export type SerializedComposerSkillNode = Spread<ComposerSkillPayload, SerializedLexicalNode>

export function localSkillTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function displaySkillNameFromName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export class ComposerSkillNode extends DecoratorNode<ReactNode> {
  __name: string
  __label: string
  __reference: string

  static getType(): string {
    return 'composer-skill'
  }

  static clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(node.__name, node.__label, node.__reference, node.__key)
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & Record<string, unknown>
  ): ComposerSkillNode {
    return $createComposerSkillNode({
      name: typeof serializedNode.name === 'string' ? serializedNode.name : '',
      label: typeof serializedNode.label === 'string' ? serializedNode.label : '',
      reference: typeof serializedNode.reference === 'string' ? serializedNode.reference : '',
    }).updateFromJSON(serializedNode)
  }

  static importDOM(): DOMConversionMap | null {
    return null
  }

  constructor(name: string, label: string, reference: string, key?: NodeKey) {
    super(key)
    this.__name = name
    this.__label = label
    this.__reference = reference
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('span')
    const className = (config.theme as Record<string, unknown>).composerSkill
    if (typeof className === 'string') {
      element.className = className
    }
    element.setAttribute('data-composer-skill-reference', this.__reference)
    element.setAttribute('data-composer-skill-name', this.__name)
    element.contentEditable = 'false'
    return element
  }

  updateDOM(): false {
    return false
  }

  exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      name: this.__name,
      label: this.__label,
      reference: this.__reference,
      type: ComposerSkillNode.getType(),
      version: 1,
    }
  }

  getTextContent(): string {
    return this.__reference
  }

  getPayload(): ComposerSkillPayload {
    return {
      name: this.__name,
      label: this.__label,
      reference: this.__reference,
    }
  }

  decorate(): ReactNode {
    return (
      <span
        data-testid={`local-skill-chip-${localSkillTestId(this.__name)}`}
        className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-[#E6D5AF] bg-[#FFF8EA] px-2 align-middle text-xs font-medium text-[#6F4D13]"
      >
        <Package className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{this.__label}</span>
      </span>
    )
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): true {
    return true
  }
}

export function $createComposerSkillNode(payload: ComposerSkillPayload): ComposerSkillNode {
  return $applyNodeReplacement(
    new ComposerSkillNode(payload.name, payload.label, payload.reference)
  )
}

export function $isComposerSkillNode(
  node: LexicalNode | null | undefined
): node is ComposerSkillNode {
  return node instanceof ComposerSkillNode
}
