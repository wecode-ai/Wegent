import type { CodeCommentContext } from '@/types/workspace-files'

function lineRangeLabel(context: CodeCommentContext): string {
  return context.startLine === context.endLine
    ? String(context.startLine)
    : `${context.startLine}-${context.endLine}`
}

function contextSource(context: CodeCommentContext): 'browser_annotation' | 'code_selection' {
  return context.source === 'browser_annotation' || context.filePath.startsWith('browser:')
    ? 'browser_annotation'
    : 'code_selection'
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
      commentNumber: context.browserAnnotation?.number ?? index + 1,
      source,
      location: contextLocationLabel(context),
      filePath: context.filePath,
      fileName: context.fileName,
      lines: source === 'code_selection' ? lineRangeLabel(context) : null,
      selectedText: context.selectedText,
      userComment: context.comment,
      adjustments: context.adjustments?.length ? context.adjustments : undefined,
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

function parseContextLines(lines: unknown): [number, number] {
  if (typeof lines !== 'string') return [1, 1]
  const match = /^(\d+)(?:-(\d+))?$/.exec(lines)
  if (!match) return [1, 1]
  return [Number(match[1]), match[2] ? Number(match[2]) : Number(match[1])]
}

function deserializeCodeCommentContext(item: unknown, index: number): CodeCommentContext | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const [startLine, endLine] = parseContextLines(record.lines)
  return {
    id: `parsed-comment-${typeof record.commentNumber === 'number' ? record.commentNumber : index + 1}-${index}`,
    source: record.source === 'browser_annotation' ? 'browser_annotation' : 'code_selection',
    filePath: typeof record.filePath === 'string' ? record.filePath : '',
    fileName: typeof record.fileName === 'string' ? record.fileName : '',
    startLine,
    endLine,
    selectedText: typeof record.selectedText === 'string' ? record.selectedText : '',
    comment: typeof record.userComment === 'string' ? record.userComment : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    adjustments: Array.isArray(record.adjustments)
      ? (record.adjustments as CodeCommentContext['adjustments'])
      : undefined,
  }
}

export function parseCodeCommentContexts(
  content: string
): { codeComments: CodeCommentContext[]; content: string } | null {
  const blockMatch = /<workspace_comment_context>[\s\S]*?<\/workspace_comment_context>/.exec(
    content
  )
  if (!blockMatch) return null
  const strippedContent = content.replace(blockMatch[0], '').trim()
  const inner = blockMatch[0]
  const jsonStart = inner.indexOf('[')
  const jsonEnd = inner.lastIndexOf(']')
  if (jsonStart < 0 || jsonEnd <= jsonStart) return { codeComments: [], content: strippedContent }
  let payload: unknown
  try {
    payload = JSON.parse(inner.slice(jsonStart, jsonEnd + 1))
  } catch {
    return { codeComments: [], content: strippedContent }
  }
  if (!Array.isArray(payload)) return { codeComments: [], content: strippedContent }
  const codeComments = payload
    .map((item, index) => deserializeCodeCommentContext(item, index))
    .filter((item): item is CodeCommentContext => item !== null)
  return { codeComments, content: strippedContent }
}
