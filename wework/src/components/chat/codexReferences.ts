import type { CodexReference, TurnFileChangesSummary } from '@/types/api'
import { classifyMarkdownLink, splitMarkdownFileLineSuffix } from './assistantMarkdownLinks'

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const CODEX_REFERENCE_DOCUMENT_EXTENSIONS = new Set([
  'doc',
  'docx',
  'log',
  'markdown',
  'md',
  'mdx',
  'odt',
  'pages',
  'pdf',
  'rst',
  'rtf',
  'tex',
  'txt',
])

export function getAssistantReferences(
  references: CodexReference[] | null | undefined,
  content: string,
  fileChanges?: TurnFileChangesSummary | null
): CodexReference[] {
  const explicitReferences =
    references?.filter(reference => reference.path && reference.path.trim()) ?? []
  return filterCodexDocumentReferences(
    uniqueCodexReferences([
      ...explicitReferences,
      ...extractFileChangeReferences(fileChanges),
      ...extractAssistantFileReferences(content),
    ])
  )
}

export function getDisplayCodexReferences(references: CodexReference[]): CodexReference[] {
  return filterCodexDocumentReferences(uniqueCodexReferences(references))
}

function extractAssistantFileReferences(content: string): CodexReference[] {
  const references: CodexReference[] = []
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const title = match[1]?.trim()
    const href = unwrapMarkdownHref(match[2])
    const target = classifyMarkdownLink(href)
    if (target.kind !== 'file') continue
    if (!isCodexDocumentReferencePath(target.path)) continue

    references.push({
      title: title || basename(target.path),
      path: target.path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
    })
  }
  return uniqueCodexReferences(references)
}

function extractFileChangeReferences(
  fileChanges: TurnFileChangesSummary | null | undefined
): CodexReference[] {
  if (!fileChanges) return []
  return fileChanges.files
    .filter(file => isCodexDocumentReferencePath(file.path))
    .map(file => ({
      path: file.path,
      title: basename(file.path),
    }))
}

function unwrapMarkdownHref(rawHref: string | undefined): string | undefined {
  const value = rawHref?.trim()
  if (!value) return undefined
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1)
  return value
}

function normalizeCodexReference(reference: CodexReference): CodexReference | null {
  const path = reference.path.trim()
  if (!path) return null

  const parsed = splitMarkdownFileLineSuffix(path)
  return {
    ...reference,
    path: parsed.path,
    lineStart: reference.lineStart ?? parsed.lineStart,
    lineEnd: reference.lineEnd ?? parsed.lineEnd,
  }
}

function uniqueCodexReferences(references: CodexReference[]): CodexReference[] {
  const uniqueReferences: CodexReference[] = []
  for (const reference of references) {
    const normalizedReference = normalizeCodexReference(reference)
    if (!normalizedReference) continue

    if (
      uniqueReferences.some(existingReference =>
        referencePathsMatch(existingReference.path, normalizedReference.path)
      )
    ) {
      continue
    }
    uniqueReferences.push(normalizedReference)
  }
  return uniqueReferences
}

function referencePathsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeReferencePath(left)
  const normalizedRight = normalizeReferencePath(right)
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  )
}

function normalizeReferencePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
}

function filterCodexDocumentReferences(references: CodexReference[]): CodexReference[] {
  return references.filter(reference => isCodexDocumentReferencePath(reference.path))
}

function isCodexDocumentReferencePath(path: string): boolean {
  const extension = fileExtension(path)
  return CODEX_REFERENCE_DOCUMENT_EXTENSIONS.has(extension)
}

export function fileExtension(path: string): string {
  const filename = basename(path)
  const index = filename.lastIndexOf('.')
  return index > -1 && index < filename.length - 1 ? filename.slice(index + 1).toLowerCase() : ''
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
