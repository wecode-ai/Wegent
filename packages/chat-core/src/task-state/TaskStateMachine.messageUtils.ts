// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate a unique message ID
 */
export function generateMessageId(type: 'user' | 'ai', subtaskId?: number): string {
  if (type === 'ai' && subtaskId) {
    return `ai-${subtaskId}`
  }
  return `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export function mergeChunkContent(
  existingContent: string,
  incomingContent: string,
  offset?: number
): { content: string; appendedContent: string } {
  if (!incomingContent) {
    return { content: existingContent, appendedContent: '' }
  }

  if (offset === undefined || offset < 0) {
    return {
      content: existingContent + incomingContent,
      appendedContent: incomingContent,
    }
  }

  const replaceTail = () => {
    const content = existingContent.slice(0, offset) + incomingContent
    return {
      content,
      appendedContent:
        content.length > existingContent.length ? content.slice(existingContent.length) : '',
    }
  }

  if (offset > existingContent.length) {
    return replaceTail()
  }

  const existingAtOffset = existingContent.slice(offset, offset + incomingContent.length)
  if (existingAtOffset === incomingContent) {
    return { content: existingContent, appendedContent: '' }
  }

  if (offset < existingContent.length) {
    const overlapLength = existingContent.length - offset
    const existingOverlap = existingContent.slice(offset)
    const incomingOverlap = incomingContent.slice(0, overlapLength)

    if (existingOverlap === incomingOverlap) {
      const appendedContent = incomingContent.slice(overlapLength)
      return {
        content: existingContent + appendedContent,
        appendedContent,
      }
    }

    return replaceTail()
  }

  return {
    content: existingContent + incomingContent,
    appendedContent: incomingContent,
  }
}
