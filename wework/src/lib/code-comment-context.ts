import type { CodeCommentContext } from '@/types/workspace-files'

function lineRangeLabel(context: CodeCommentContext): string {
  return context.startLine === context.endLine
    ? String(context.startLine)
    : `${context.startLine}-${context.endLine}`
}

export function appendCodeCommentContexts(
  message: string,
  contexts: CodeCommentContext[],
): string {
  if (contexts.length === 0) return message
  const trimmedMessage = message.trim()

  const blocks = contexts.map((context, index) =>
    [
      `Comment ${index + 1}`,
      `File: ${context.filePath}`,
      `Lines: ${lineRangeLabel(context)}`,
      'Selected code:',
      '```',
      context.selectedText,
      '```',
      `User comment: ${context.comment}`,
    ].join('\n'),
  )

  const contextBlock = [
    '<code_comment_context>',
    blocks.join('\n\n'),
    '</code_comment_context>',
  ].join('\n')

  return trimmedMessage ? [trimmedMessage, '', contextBlock].join('\n') : contextBlock
}
