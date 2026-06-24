// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MessageBlock } from '../message-blocks'

export type StreamingBlockType = 'text' | 'thinking'

interface MergeStreamingBlocksInput {
  existingBlocks: MessageBlock[]
  incomingBlocks: MessageBlock[]
  content?: string
  blockId?: string
  reasoningChunk?: string
}

export function mergeStreamingBlocks({
  existingBlocks,
  incomingBlocks,
  content,
  blockId,
  reasoningChunk,
}: MergeStreamingBlocksInput): MessageBlock[] {
  if (reasoningChunk) {
    return mergeReasoningBlock(existingBlocks, reasoningChunk)
  }

  if (blockId && content) {
    return mergeTextBlockWithId(existingBlocks, blockId, content)
  }

  if (content && !blockId && incomingBlocks.length === 0) {
    return mergeTextWithoutBlockId(existingBlocks, content)
  }

  if (incomingBlocks.length === 0) {
    return existingBlocks
  }

  return mergeIncomingBlocks(existingBlocks, incomingBlocks)
}

export function mergeReasoningBlock(
  existingBlocks: MessageBlock[],
  reasoningChunk: string
): MessageBlock[] {
  const blocksArray = finalizeStreamingBlocks(existingBlocks, ['text'])
  const lastIndex = blocksArray.length - 1
  const lastBlock = blocksArray[lastIndex]

  if (lastBlock && lastBlock.type === 'thinking' && lastBlock.status === 'streaming') {
    return blocksArray.map((block, index) =>
      index === lastIndex && block.type === 'thinking'
        ? {
            ...block,
            content: (block.content || '') + reasoningChunk,
          }
        : block
    )
  }

  return [
    ...blocksArray,
    {
      id: generateBlockId('thinking'),
      type: 'thinking',
      content: reasoningChunk,
      status: 'streaming',
      timestamp: Date.now(),
    },
  ]
}

export function finalizeStreamingBlocks(
  blocks: MessageBlock[],
  blockTypes: StreamingBlockType[]
): MessageBlock[] {
  const blockTypeSet = new Set<string>(blockTypes)

  return blocks.map(block => {
    if (block.status === 'streaming' && blockTypeSet.has(block.type)) {
      return {
        ...block,
        status: 'done' as const,
      }
    }
    return block
  })
}

export function mergeBlocksForDone(
  existingMessageBlocks: MessageBlock[],
  incomingBlocks: MessageBlock[]
): MessageBlock[] {
  const existingBlocks = finalizeStreamingBlocks(existingMessageBlocks, ['text', 'thinking'])

  if (existingBlocks.length === 0) {
    return incomingBlocks
  }

  if (incomingBlocks.length === 0) {
    return existingBlocks
  }

  if (existingBlocks.some(block => block.type === 'thinking')) {
    return mergeDoneBlocksWithInlineThinking(existingBlocks, incomingBlocks)
  }

  return mergeDoneBlocksWithBackendOrder(existingBlocks, incomingBlocks)
}

function mergeTextBlockWithId(
  existingBlocks: MessageBlock[],
  blockId: string,
  content: string
): MessageBlock[] {
  const finalizedBlocks = finalizeStreamingBlocks(existingBlocks, ['thinking'])
  const blocksMap = new Map(finalizedBlocks.map(block => [block.id, block]))
  const targetBlock = blocksMap.get(blockId)

  if (targetBlock && targetBlock.type === 'text') {
    blocksMap.set(blockId, {
      ...targetBlock,
      content: (targetBlock.content || '') + content,
    })
  } else if (!targetBlock) {
    blocksMap.set(blockId, {
      id: blockId,
      type: 'text',
      content,
      status: 'streaming',
      timestamp: Date.now(),
    })
  }

  return Array.from(blocksMap.values())
}

function mergeTextWithoutBlockId(existingBlocks: MessageBlock[], content: string): MessageBlock[] {
  const blocksArray = finalizeStreamingBlocks(existingBlocks, ['thinking'])
  const lastIndex = blocksArray.length - 1
  const lastBlock = blocksArray[lastIndex]

  if (lastBlock && lastBlock.type === 'text' && lastBlock.status === 'streaming') {
    return blocksArray.map((block, index) =>
      index === lastIndex && block.type === 'text'
        ? {
            ...block,
            content: (block.content || '') + content,
          }
        : block
    )
  }

  return [
    ...blocksArray,
    {
      id: generateBlockId('text'),
      type: 'text',
      content,
      status: 'streaming',
      timestamp: Date.now(),
    },
  ]
}

function mergeIncomingBlocks(
  existingBlocks: MessageBlock[],
  incomingBlocks: MessageBlock[]
): MessageBlock[] {
  const blocksArray = finalizeStreamingBlocks(existingBlocks, ['text', 'thinking'])
  const blocksMap = new Map(blocksArray.map(block => [block.id, block]))

  incomingBlocks.forEach(incomingBlock => {
    const existingBlock = blocksMap.get(incomingBlock.id)
    blocksMap.set(
      incomingBlock.id,
      existingBlock ? { ...existingBlock, ...incomingBlock } : incomingBlock
    )
  })

  return Array.from(blocksMap.values())
}

function mergeDoneBlocksWithInlineThinking(
  existingBlocks: MessageBlock[],
  incomingBlocks: MessageBlock[]
): MessageBlock[] {
  const incomingBlocksMap = new Map(incomingBlocks.map(block => [block.id, block]))
  const mergedBlocks = existingBlocks.map(existingBlock => {
    const incomingBlock = incomingBlocksMap.get(existingBlock.id)
    return incomingBlock ? { ...existingBlock, ...incomingBlock } : existingBlock
  })
  const existingIds = new Set(existingBlocks.map(block => block.id))
  const appendedBlocks = incomingBlocks.filter(
    block => !existingIds.has(block.id) && !hasDuplicateBlockContent(existingBlocks, block)
  )

  return [...mergedBlocks, ...appendedBlocks]
}

function mergeDoneBlocksWithBackendOrder(
  existingBlocks: MessageBlock[],
  incomingBlocks: MessageBlock[]
): MessageBlock[] {
  const existingToolBlocksMap = new Map(
    existingBlocks.filter(block => block.type !== 'text').map(block => [block.id, block])
  )

  return incomingBlocks.map(incomingBlock => {
    if (incomingBlock.type === 'text') {
      return incomingBlock
    }

    const existingBlock = existingToolBlocksMap.get(incomingBlock.id)
    return existingBlock ? { ...existingBlock, ...incomingBlock } : incomingBlock
  })
}

function hasDuplicateBlockContent(
  existingBlocks: MessageBlock[],
  incomingBlock: MessageBlock
): boolean {
  return (
    (incomingBlock.type === 'text' || incomingBlock.type === 'thinking') &&
    existingBlocks.some(
      existingBlock =>
        existingBlock.type === incomingBlock.type && existingBlock.content === incomingBlock.content
    )
  )
}

function generateBlockId(type: StreamingBlockType): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}
