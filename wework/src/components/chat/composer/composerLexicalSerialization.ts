import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
} from 'lexical'
import {
  $createComposerSkillNode,
  $isComposerSkillNode,
  displaySkillNameFromName,
  type ComposerSkillPayload,
} from './ComposerSkillNode'

const LOCAL_MENTION_REFERENCE_PATTERN =
  /\[\$([^\]]+)]\(((?:skill:\/\/[^)]+SKILL\.md)|(?:app:\/\/[^)]+)|(?:plugin:\/\/[^)]+))\)/g

export interface ParsedComposerSkillReference extends ComposerSkillPayload {
  start: number
  end: number
}

export function parseComposerSkillReferences(value: string): ParsedComposerSkillReference[] {
  return Array.from(value.matchAll(LOCAL_MENTION_REFERENCE_PATTERN)).map(match => {
    const start = match.index ?? 0
    const reference = match[0]
    const name = match[1]
    return {
      name,
      label: displaySkillNameFromName(name),
      reference,
      start,
      end: start + reference.length,
    }
  })
}

export function $setComposerValue(value: string, selectionOffset?: number): void {
  const root = $getRoot()
  root.clear()

  const paragraph = $createParagraphNode()
  root.append(paragraph)

  const references = parseComposerSkillReferences(value)
  let offset = 0

  const appendText = (text: string) => {
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append($createLineBreakNode())
      if (line) paragraph.append($createTextNode(line))
    })
  }

  references.forEach(reference => {
    if (reference.start < offset) return
    appendText(value.slice(offset, reference.start))
    paragraph.append(
      $createComposerSkillNode({
        name: reference.name,
        label: reference.label,
        reference: reference.reference,
      })
    )
    offset = reference.end
  })

  appendText(value.slice(offset))

  if (selectionOffset !== undefined) {
    $selectComposerOffset(selectionOffset)
  }
}

export function $getComposerValue(): string {
  const parts: string[] = []

  const appendNode = (node: LexicalNode) => {
    if ($isTextNode(node) || $isLineBreakNode(node)) {
      parts.push(node.getTextContent())
      return
    }
    if ($isComposerSkillNode(node)) {
      parts.push(node.getPayload().reference)
      return
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(appendNode)
    }
  }

  $getRoot()
    .getChildren()
    .forEach((node, index) => {
      if (index > 0) parts.push('\n')
      appendNode(node)
    })

  return parts.join('')
}

export function $getComposerSelectionOffset(): number {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return $getComposerValue().length

  return $getComposerPointOffset(selection.anchor.getNode(), selection.anchor.offset)
}

export function $getComposerSelectionRange(): { start: number; end: number } {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) {
    const end = $getComposerValue().length
    return { start: end, end }
  }

  const anchor = $getComposerPointOffset(selection.anchor.getNode(), selection.anchor.offset)
  const focus = $getComposerPointOffset(selection.focus.getNode(), selection.focus.offset)
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
  }
}

function $getComposerPointOffset(anchorNode: LexicalNode, anchorOffset: number): number {
  let offset = 0
  let found = false

  const visit = (node: LexicalNode) => {
    if (found) return

    if (node.getKey() === anchorNode.getKey()) {
      if ($isTextNode(node)) {
        offset += anchorOffset
      } else if ($isComposerSkillNode(node)) {
        offset += anchorOffset > 0 ? node.getPayload().reference.length : 0
      }
      found = true
      return
    }

    if ($isTextNode(node) || $isLineBreakNode(node)) {
      offset += node.getTextContent().length
      return
    }
    if ($isComposerSkillNode(node)) {
      offset += node.getPayload().reference.length
      return
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(visit)
    }
  }

  $getRoot()
    .getChildren()
    .forEach((node, index) => {
      if (found) return
      if (index > 0) offset += 1
      visit(node)
    })

  return offset
}

export function $selectComposerOffset(targetOffset: number): void {
  const normalizedTarget = Math.max(0, targetOffset)
  let offset = 0
  let selected = false

  const selectInNode = (node: LexicalNode) => {
    if (selected) return

    if ($isTextNode(node)) {
      const length = node.getTextContent().length
      if (normalizedTarget <= offset + length) {
        const localOffset = Math.max(0, Math.min(length, normalizedTarget - offset))
        node.select(localOffset, localOffset)
        selected = true
        return
      }
      offset += length
      return
    }

    if ($isLineBreakNode(node)) {
      const length = node.getTextContent().length
      if (normalizedTarget <= offset + length) {
        node.selectNext()
        selected = true
        return
      }
      offset += length
      return
    }

    if ($isComposerSkillNode(node)) {
      const length = node.getPayload().reference.length
      if (normalizedTarget <= offset) {
        node.selectPrevious()
        selected = true
        return
      }
      if (normalizedTarget <= offset + length) {
        node.selectNext()
        selected = true
        return
      }
      offset += length
      return
    }

    if ($isElementNode(node)) {
      node.getChildren().forEach(selectInNode)
    }
  }

  $getRoot()
    .getChildren()
    .forEach((node, index) => {
      if (selected) return
      if (index > 0) offset += 1
      selectInNode(node)
    })

  if (!selected) {
    $getRoot().selectEnd()
  }
}
