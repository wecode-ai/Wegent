import type { CodexReference, TurnFileChangesSummary } from '@/types/api'
import { classifyMarkdownLink, splitMarkdownFileLineSuffix } from './assistantMarkdownLinks'

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const CODEX_REFERENCE_DOCUMENT_EXTENSIONS = new Set([
  'doc',
  'docx',
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

    const existingIndex = uniqueReferences.findIndex(existingReference =>
      referencePathsMatch(existingReference.path, normalizedReference.path)
    )
    if (existingIndex >= 0) {
      uniqueReferences[existingIndex] = mergeCodexReferences(
        uniqueReferences[existingIndex],
        normalizedReference
      )
      continue
    }
    uniqueReferences.push(normalizedReference)
  }
  return uniqueReferences
}

function mergeCodexReferences(
  existingReference: CodexReference,
  candidateReference: CodexReference
): CodexReference {
  const path = isMoreSpecificReferencePath(candidateReference.path, existingReference.path)
    ? candidateReference.path
    : existingReference.path
  return {
    ...existingReference,
    path,
    title: existingReference.title ?? candidateReference.title,
    lineStart: existingReference.lineStart ?? candidateReference.lineStart,
    lineEnd: existingReference.lineEnd ?? candidateReference.lineEnd,
  }
}

function isMoreSpecificReferencePath(candidatePath: string, currentPath: string): boolean {
  const candidate = normalizeReferencePath(candidatePath)
  const current = normalizeReferencePath(currentPath)
  const candidateAbsolute = isAbsoluteReferencePath(candidate)
  const currentAbsolute = isAbsoluteReferencePath(current)
  if (candidateAbsolute !== currentAbsolute) return candidateAbsolute
  return candidate.length > current.length
}

function isAbsoluteReferencePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path)
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
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  const drive = normalized.match(/^[a-zA-Z]:\//)?.[0]
  const absolute = normalized.startsWith('/') || Boolean(drive)
  const segments: string[] = []

  for (const segment of normalized.slice(drive?.length ?? (absolute ? 1 : 0)).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  if (drive) return `${drive}${segments.join('/')}`
  if (absolute) return `/${segments.join('/')}`
  return segments.join('/') || '.'
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
