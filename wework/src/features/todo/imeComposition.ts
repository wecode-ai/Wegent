import type { Block, PartialBlock } from '@blocknote/core'

export interface ImeCompositionSnapshot {
  blockId: string
  nextBlockId?: string
  parentBlockId?: string
}

interface ImeDuplicateRepair {
  targetBlockId: string
  duplicateBlockId?: string
  content: PartialBlock['content']
}

export function inlineContentText(content: Block['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      if ('text' in item && typeof item.text === 'string') return item.text
      if ('content' in item && Array.isArray(item.content)) {
        return item.content.map(child => ('text' in child ? child.text : '')).join('')
      }
      return ''
    })
    .join('')
}

const PINYIN_COMPOSITION_BUFFER = /^[a-zA-ZüÜvV' -]+$/
const HAN_TEXT = /\p{Script=Han}/u

export function detectInitialImeDuplicate(
  snapshot: ImeCompositionSnapshot,
  originalBlock: Block | undefined,
  nextBlock: Block | undefined,
  nextParentBlockId: string | undefined,
  committedText: string
): ImeDuplicateRepair | null {
  if (!originalBlock || !nextBlock) return null
  if (nextBlock.id === snapshot.nextBlockId) return null
  if (nextParentBlockId !== snapshot.parentBlockId) return null
  if (originalBlock.type !== nextBlock.type) return null
  if (originalBlock.children.length || nextBlock.children.length) return null

  const leakedPinyin = inlineContentText(originalBlock.content)
  const committedBlockText = inlineContentText(nextBlock.content)
  if (!leakedPinyin || !PINYIN_COMPOSITION_BUFFER.test(leakedPinyin)) return null
  if (!committedBlockText || !HAN_TEXT.test(committedBlockText)) return null
  if (committedText && committedBlockText !== committedText) return null

  return {
    targetBlockId: originalBlock.id,
    duplicateBlockId: nextBlock.id,
    content: nextBlock.content,
  }
}

export function detectInitialImeCodeBlockDuplicate(
  snapshot: ImeCompositionSnapshot,
  originalBlock: Block | undefined,
  nextBlock: Block | undefined,
  committedText: string
): ImeDuplicateRepair | null {
  if (!originalBlock || originalBlock.id !== snapshot.blockId) return null
  if (originalBlock.type !== 'codeBlock' || originalBlock.children.length) return null
  if (nextBlock?.id !== snapshot.nextBlockId) return null

  const lines = inlineContentText(originalBlock.content).replace(/\r\n/g, '\n').split('\n')
  if (lines.length !== 2) return null
  const [leakedPinyin, committedLine] = lines
  if (!leakedPinyin || !PINYIN_COMPOSITION_BUFFER.test(leakedPinyin)) return null
  if (!committedLine || !HAN_TEXT.test(committedLine)) return null
  if (committedText && committedLine !== committedText) return null

  return {
    targetBlockId: originalBlock.id,
    content: committedLine,
  }
}
