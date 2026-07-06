import type { CodeCommentContext } from '@/types/workspace-files'

function lineRangeLabel(context: CodeCommentContext): string {
  return context.startLine === context.endLine
    ? String(context.startLine)
    : `${context.startLine}-${context.endLine}`
}

function contextSource(context: CodeCommentContext): 'browser_annotation' | 'code_selection' {
  return context.filePath.startsWith('browser:') ? 'browser_annotation' : 'code_selection'
}

function contextLocationLabel(context: CodeCommentContext): string {
  if (contextSource(context) === 'browser_annotation') {
    return `Web page: ${context.filePath.slice('browser:'.length) || context.fileName}`
  }
  return `File: ${context.filePath}, lines ${lineRangeLabel(context)}`
}

function serializedCodeCommentContexts(contexts: CodeCommentContext[]): string {
  const payload = contexts.map((context, index) => {
    const source = contextSource(context)
    return {
      commentNumber: index + 1,
      source,
      location: contextLocationLabel(context),
      filePath: context.filePath,
      fileName: context.fileName,
      lines: source === 'code_selection' ? lineRangeLabel(context) : null,
      selectedText: context.selectedText,
      userComment: context.comment,
      createdAt: context.createdAt,
    }
  })

  return JSON.stringify(payload, null, 2).replace(/</g, '\\u003c')
}

export function appendCodeCommentContexts(message: string, contexts: CodeCommentContext[]): string {
  if (contexts.length === 0) return message
  const trimmedMessage = message.trim()

  const contextBlock = [
    '<workspace_comment_context>',
    'The user attached the following comments. Treat browser_annotation items as comments on parts of the visible web page, and code_selection items as comments on selected code.',
    serializedCodeCommentContexts(contexts),
    '</workspace_comment_context>',
  ].join('\n')

  return trimmedMessage ? [trimmedMessage, '', contextBlock].join('\n') : contextBlock
}
