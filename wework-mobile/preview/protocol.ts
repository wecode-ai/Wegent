import {
  classifyMarkdownLink,
  transformMarkdownUrl,
} from '../../packages/collaboration/src/markdown/assistantMarkdownLinks'
import { workspaceFileViewerType } from '../../packages/chat-core/src/workspace-file-types'

export interface PreviewState {
  name: string
  path: string
  mimeType: string
  size: number
  url: string
  text?: string
  truncated?: boolean
  kind: 'text' | 'binary' | 'diff'
  lineStart?: number
  lineEnd?: number
  mode: 'preview' | 'source'
  search: string
  wrap: boolean
  initialPosition: number
  theme: 'light' | 'dark'
  plantumlServerUrl: string
}

type PreviewDocumentKind = Pick<PreviewState, 'kind' | 'name' | 'mimeType'>

function rendererType(document: PreviewDocumentKind): string {
  return (
    workspaceFileViewerType(document.name, document.mimeType) ??
    document.name.split('.').at(-1)?.toLowerCase() ??
    ''
  )
}

export function canPreviewSource(document: PreviewDocumentKind): boolean {
  return (
    document.kind !== 'binary' ||
    ['mermaid', 'plantuml', 'csv', 'svg'].includes(rendererType(document))
  )
}

export function canSearchPreview(
  document: PreviewDocumentKind,
  mode: 'preview' | 'source' = 'preview'
): boolean {
  if (document.kind !== 'binary' || (mode === 'source' && canPreviewSource(document))) return true
  return [
    'pdf',
    'doc',
    'docx',
    'odt',
    'rtf',
    'ppt',
    'pptx',
    'odp',
    'xls',
    'xlsx',
    'ods',
    'csv',
    'epub',
    'xmind',
  ].includes(rendererType(document))
}

export type PreviewEvent =
  | { type: 'ready' }
  | { type: 'position'; value: number }
  | { type: 'link'; href: string }
  | { type: 'error'; message: string }
  | { type: 'resource'; id: string; href: string }

export interface PreviewResourceResponse {
  token: string
  id: string
  url?: string
  error?: string
}

export function parsePreviewEvent(raw: string, token: string): PreviewEvent | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.token !== token || !token) return null
  if (event.type === 'ready') return { type: 'ready' }
  if (event.type === 'position' && typeof event.value === 'number' && Number.isFinite(event.value))
    return { type: 'position', value: Math.max(0, event.value) }
  if (event.type === 'link' && typeof event.href === 'string')
    return { type: 'link', href: event.href }
  if (event.type === 'error' && typeof event.message === 'string')
    return { type: 'error', message: event.message }
  if (
    event.type === 'resource' &&
    typeof event.id === 'string' &&
    typeof event.href === 'string' &&
    isPreviewResourceAllowed(event.href)
  )
    return { type: 'resource', id: event.id, href: event.href }
  return null
}

export function isPreviewResourceAllowed(href: string): boolean {
  if (!isPreviewLinkAllowed(href)) return false
  const safe = transformMarkdownUrl(href, 'href')
  return Boolean(safe && (classifyMarkdownLink(safe).kind === 'file' || /^https?:/i.test(safe)))
}

export function isPreviewLinkAllowed(href: string): boolean {
  // Relative workspace references are resolved by the native owner, never by WebView navigation.
  if (!href || /^[\u0000-\u0020]/.test(href) || /[\u0000-\u001f]/.test(href)) return false
  const safe = transformMarkdownUrl(href, 'href')
  return Boolean(safe && classifyMarkdownLink(safe).kind !== 'none')
}
