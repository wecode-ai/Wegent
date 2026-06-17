import type { CodeCommentContext } from '@/types/workspace-files'

function lineRangeLabel(context: CodeCommentContext): string {
  return context.startLine === context.endLine
    ? String(context.startLine)
    : `${context.startLine}-${context.endLine}`
}

function serializedCodeCommentContexts(contexts: CodeCommentContext[]): string {
  const payload = contexts.map((context, index) => ({
    commentNumber: index + 1,
    filePath: context.filePath,
    fileName: context.fileName,
    lines: lineRangeLabel(context),
    selectedCode: context.selectedText,
    userComment: context.comment,
    createdAt: context.createdAt,
  }))

  return JSON.stringify(payload, null, 2).replace(/</g, '\\u003c')
}

export function appendCodeCommentContexts(
  message: string,
  contexts: CodeCommentContext[],
): string {
  if (contexts.length === 0) return message
  const trimmedMessage = message.trim()

  const contextBlock = [
    '<code_comment_context>',
    serializedCodeCommentContexts(contexts),
    '</code_comment_context>',
  ].join('\n')

  return trimmedMessage ? [trimmedMessage, '', contextBlock].join('\n') : contextBlock
}
