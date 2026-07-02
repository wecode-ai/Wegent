// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate a unique message ID
 */
export function generateMessageId(type: 'user' | 'ai', turnId?: number): string {
  if (type === 'ai' && turnId) {
    return `ai-${turnId}`
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

  const existingCodePoints = Array.from(existingContent)
  const incomingCodePoints = Array.from(incomingContent)
  const existingLength = existingCodePoints.length

  const sliceExisting = (start: number, end?: number) =>
    existingCodePoints.slice(start, end).join('')
  const sliceIncoming = (start: number, end?: number) =>
    incomingCodePoints.slice(start, end).join('')
  const getAppendedContent = (content: string) => {
    const contentCodePoints = Array.from(content)
    return contentCodePoints.length > existingLength
      ? contentCodePoints.slice(existingLength).join('')
      : ''
  }

  const replaceTail = () => {
    const content = sliceExisting(0, offset) + incomingContent
    return {
      content,
      appendedContent: getAppendedContent(content),
    }
  }

  if (offset > existingLength) {
    return replaceTail()
  }

  const existingAtOffset = sliceExisting(offset, offset + incomingCodePoints.length)
  if (existingAtOffset === incomingContent) {
    return { content: existingContent, appendedContent: '' }
  }

  if (offset < existingLength) {
    const overlapLength = existingLength - offset
    const existingOverlap = sliceExisting(offset)
    const incomingOverlap = sliceIncoming(0, overlapLength)

    if (existingOverlap === incomingOverlap) {
      const appendedContent = sliceIncoming(overlapLength)
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
