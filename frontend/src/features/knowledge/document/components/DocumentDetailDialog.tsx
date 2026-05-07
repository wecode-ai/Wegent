// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  FileText,
  RefreshCw,
  Copy,
  Check,
  Pencil,
  X,
  Save,
  Eye,
  Code,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import { ChunksSection } from './ChunksSection'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { getKnowledgeConfig, listKnowledgeBases } from '@/apis/knowledge'
import { buildKbUrl } from '@/utils/knowledgeUrl'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useRouter } from 'next/navigation'
// Import WysiwygEditorProps type for language prop
import type { WysiwygEditorProps } from '@/components/common/WysiwygEditor'

// Dynamically import the WYSIWYG editor to avoid SSR issues
const WysiwygEditor = dynamic(
  () => import('@/components/common/WysiwygEditor').then(mod => mod.WysiwygEditor),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[300px] animate-pulse rounded-lg bg-surface flex items-center justify-center">
        <Spinner />
      </div>
    ),
  }
)

// Dynamically import EnhancedMarkdown for markdown preview
const EnhancedMarkdown = dynamic(() => import('@/components/common/EnhancedMarkdown'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[100px] animate-pulse rounded-lg bg-surface flex items-center justify-center">
      <Spinner />
    </div>
  ),
})

/**
 * Check if content contains markdown syntax
 * Returns true if the content appears to be markdown
 */
function containsMarkdownSyntax(content: string): boolean {
  if (!content) return false

  // Check for common markdown patterns
  // Note: Table separator regex uses string concatenation to avoid Tailwind CSS
  // scanner misinterpreting the pattern as an arbitrary value class
  const markdownPatterns = [
    /^#{1,6}\s+.+$/m, // Headers: # Header
    /\*\*[^*]+\*\*/, // Bold: **text**
    /\*[^*]+\*/, // Italic: *text*
    /__[^_]+__/, // Bold: __text__
    /_[^_]+_/, // Italic: _text_
    /\[.+\]\(.+\)/, // Links: [text](url)
    /!\[.*\]\(.+\)/, // Images: ![alt](url)
    /^[-*+]\s+.+$/m, // Unordered lists: - item or * item
    /^\d+\.\s+.+$/m, // Ordered lists: 1. item
    /^>\s+.+$/m, // Blockquotes: > quote
    /`[^`]+`/, // Inline code: `code`
    /^```[\s\S]*?```$/m, // Code blocks: ```code```
    /^\|.+\|$/m, // Tables: | col1 | col2 |
    // Table separators: |---|---| - split pattern to avoid Tailwind scanner
    new RegExp('^' + '[-' + ':]+\\|' + '[-' + ':|\\s]+$', 'm'),
    /^---+$/m, // Horizontal rules: ---
    /^\*\*\*+$/m, // Horizontal rules: ***
  ]

  return markdownPatterns.some(pattern => pattern.test(content))
}

/**
 * Check if file extension indicates markdown content
 */
function isMarkdownFileExtension(extension: string | undefined): boolean {
  if (!extension) return false
  const mdExtensions = ['md', 'markdown', 'mdx', 'mdown', 'mkd', 'mkdn']
  return mdExtensions.includes(extension.toLowerCase())
}

/**
 * Check if file extension indicates JSON content
 */
function isJsonFileExtension(extension: string | undefined): boolean {
  if (!extension) return false
  const jsonExtensions = ['json', 'jsonl', 'json5']
  return jsonExtensions.includes(extension.toLowerCase())
}

/**
 * Map file extension to editor language for syntax highlighting
 */
function getEditorLanguage(extension: string | undefined): WysiwygEditorProps['language'] {
  if (!extension) return 'markdown'

  const ext = extension.toLowerCase()

  const languageMap: Record<string, WysiwygEditorProps['language']> = {
    // Markdown
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    mdown: 'markdown',
    mkd: 'markdown',
    mkdn: 'markdown',
    // JSON
    json: 'json',
    jsonl: 'json',
    json5: 'json',
    // JavaScript
    js: 'javascript',
    mjs: 'javascript',
    jsx: 'jsx',
    // TypeScript
    ts: 'typescript',
    tsx: 'tsx',
    // Python
    py: 'python',
    // HTML
    html: 'html',
    htm: 'html',
    // CSS
    css: 'css',
    scss: 'css',
    sass: 'css',
    less: 'css',
    // YAML
    yaml: 'yaml',
    yml: 'yaml',
    // SQL
    sql: 'sql',
    // XML
    xml: 'xml',
    svg: 'xml',
    // C/C++
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    // Go
    go: 'go',
    // Java
    java: 'java',
    // Rust
    rs: 'rust',
    rust: 'rust',
  }

  return languageMap[ext] || 'text'
}

/**
 * Try to parse and format JSON content
 * Returns formatted JSON string if valid, null if invalid
 */
function formatJsonContent(content: string): string | null {
  if (!content) return null
  try {
    // Try to parse as JSON
    const parsed = JSON.parse(content)
    // Format with 2-space indentation
    return JSON.stringify(parsed, null, 2)
  } catch {
    // Not valid JSON
    return null
  }
}

/**
 * Check if content appears to be JSON (even if file extension doesn't indicate it)
 */
function looksLikeJson(content: string): boolean {
  if (!content) return false
  const trimmed = content.trim()
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
}

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  knowledgeBaseId: number
  /** Knowledge base type (reserved for future use) */
  kbType?: 'notebook' | 'classic'
  /** Whether the current user can edit this document */
  canEdit?: boolean
  /** Current knowledge base name - used for resolving cross-KB relative links */
  knowledgeBaseName?: string
  /** Current knowledge base namespace - used for resolving cross-namespace relative links */
  knowledgeBaseNamespace?: string
  /** Whether this KB belongs to an organization-level namespace (affects URL format) */
  isOrganization?: boolean
}

/**
 * Resolve a relative wiki document link to a knowledge base page URL.
 *
 * The virtual path hierarchy is: namespace/kb-name/doc-path/file.ext
 * Resolution uses standard relative path semantics from the current document's
 * virtual full path.
 *
 * Examples (current doc: "default/my-wiki/src/rag.md"):
 *   - "sibling.md"                    → same KB (stays within "default/my-wiki/src/")
 *   - "../other.md"                   → same KB parent dir ("default/my-wiki/")
 *   - "../../other-kb/path.md"        → cross-KB, same namespace ("default/other-kb/")
 *   - "../../../other-ns/kb/path.md"  → cross-namespace KB
 *
 * Returns null if the href is not a relative wiki link (e.g. absolute HTTP URL).
 */
async function resolveWikiLink(
  href: string,
  currentKbId: number,
  currentDocName: string,
  currentKbName: string,
  currentNamespace: string,
  currentIsOrganization: boolean
): Promise<string | null> {
  // Skip external URLs and anchor-only links
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('#')) {
    return null
  }

  // Handle absolute virtual paths: /namespace/kb-name/optional/path/doc.md
  if (href.startsWith('/')) {
    const parts = href.slice(1).split('/').filter(Boolean)
    if (parts.length < 2) return null
    // Decode URI components to handle non-ASCII characters in namespace/kb-name
    const targetNamespace = decodeURIComponent(parts[0])
    const targetKbName = decodeURIComponent(parts[1])
    // doc path is everything after namespace/kb-name (decode each segment)
    const docPath = parts
      .slice(2)
      .map(p => decodeURIComponent(p))
      .join('/')

    // Same KB - no lookup needed
    if (targetNamespace === currentNamespace && targetKbName === currentKbName) {
      return buildKbUrl(
        currentNamespace,
        currentKbName,
        currentIsOrganization,
        docPath || undefined
      )
    }

    // Different KB - verify it exists then construct virtual URL directly (no kbId lookup needed)
    // For cross-KB links, we don't know isOrganization, so use namespace-based URL
    const exists = await checkKnowledgeBaseExists(targetKbName, targetNamespace)
    if (!exists) return null
    return buildKbUrl(targetNamespace, targetKbName, false, docPath || undefined)
  }

  // Handle relative paths using virtual path hierarchy: namespace/kb-name/doc-path
  // e.g. current doc "default/my-wiki/src/rag.md" → virtualDir = "default/my-wiki/src"
  const virtualDocPath = `${currentNamespace}/${currentKbName}/${currentDocName}`
  const virtualDir = virtualDocPath.slice(0, virtualDocPath.lastIndexOf('/'))

  // Decode href in case the markdown renderer URL-encoded non-ASCII characters
  const decodedHref = decodeURIComponent(href)
  const resolved = resolveRelativePath(virtualDir, decodedHref)

  // resolved is a normalized path like "default/other-kb/path.md" or "../escaped/path.md"
  // Since the virtual base has at least 2 segments (ns/kb), any non-escaped result
  // will have the first segment as namespace and second as kb-name.
  const parts = resolved.split('/')

  if (parts.length >= 2 && !parts[0].startsWith('..')) {
    const targetNamespace = parts[0]
    const targetKbName = parts[1]
    // doc path is everything after namespace/kb-name
    const docPath = parts.slice(2).join('/')

    // Same KB - no lookup needed
    if (targetNamespace === currentNamespace && targetKbName === currentKbName) {
      return buildKbUrl(
        currentNamespace,
        currentKbName,
        currentIsOrganization,
        docPath || undefined
      )
    }

    // Different KB - verify it exists then construct virtual URL directly (no kbId lookup needed)
    // For cross-KB links, we don't know isOrganization, so use namespace-based URL
    const exists = await checkKnowledgeBaseExists(targetKbName, targetNamespace)
    if (!exists) return null
    return buildKbUrl(targetNamespace, targetKbName, false, docPath || undefined)
  }
  // Resolved path escaped the virtual root entirely - treat as same KB fallback
  return buildKbUrl(currentNamespace, currentKbName, currentIsOrganization)
}

/**
 * Resolve a relative path against a base directory.
 * Returns the normalized path (may start with "../" if it escapes the root).
 */
function resolveRelativePath(baseDir: string, relativePath: string): string {
  // Split base dir into segments (filter empty strings)
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : []
  const relParts = relativePath.split('/')

  const stack = [...baseParts]
  for (const part of relParts) {
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop()
      } else {
        // Escaping root - push sentinel to track depth
        stack.push('..')
      }
    } else if (part !== '.') {
      stack.push(part)
    }
  }

  return stack.join('/')
}

/** Check if a knowledge base exists by name and namespace. Returns true if found. */
async function checkKnowledgeBaseExists(name: string, namespace: string): Promise<boolean> {
  try {
    const response = await listKnowledgeBases('all')
    return response.items.some(
      item =>
        item.name.toLowerCase() === name.toLowerCase() &&
        item.namespace.toLowerCase() === namespace.toLowerCase()
    )
  } catch {
    return false
  }
}

export function DocumentDetailDialog({
  open,
  onOpenChange,
  document,
  knowledgeBaseId,
  kbType: _kbType,
  canEdit = false,
  knowledgeBaseName = '',
  knowledgeBaseNamespace = 'default',
  isOrganization = false,
}: DocumentDetailDialogProps) {
  const { t, getCurrentLanguage } = useTranslation('knowledge')
  const { theme } = useTheme()
  const router = useRouter()
  const [copiedContent, setCopiedContent] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  // Loading state for loading full content before editing
  const [isLoadingFullContent, setIsLoadingFullContent] = useState(false)
  // Ref to store the content at the start of editing for accurate change detection
  const editStartContentRef = useRef<string>('')
  // View mode: 'preview' for markdown rendering/formatted JSON, 'raw' for plain text
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  // Fullscreen mode for editing
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Chunk storage configuration - controls whether chunks section is visible
  const [chunkStorageEnabled, setChunkStorageEnabled] = useState(false)

  // Fetch knowledge config on mount to check if chunk storage is enabled
  useEffect(() => {
    getKnowledgeConfig()
      .then(config => {
        setChunkStorageEnabled(config.chunk_storage_enabled)
      })
      .catch(() => {
        // If config fetch fails, default to hiding chunks section
        setChunkStorageEnabled(false)
      })
  }, [])

  const {
    detail,
    loading,
    error,
    refresh,
    loadingMore,
    hasMoreContent,
    fullContent,
    loadMore,
    loadAllContent,
  } = useDocumentDetail({
    kbId: knowledgeBaseId,
    docId: document?.id || 0,
    enabled: open && !!document,
  })

  // Check if content is JSON (by file extension or content detection)
  const isJsonContent = useMemo(() => {
    if (!fullContent) return false
    return isJsonFileExtension(document?.file_extension) || looksLikeJson(fullContent)
  }, [fullContent, document?.file_extension])

  // Format JSON content for display
  const formattedJsonContent = useMemo(() => {
    if (!isJsonContent || !fullContent) return null
    return formatJsonContent(fullContent)
  }, [isJsonContent, fullContent])

  // Check if document is editable (for both notebook and classic KB types, TEXT type or plain text files)
  const editableExtensions = [
    'adoc',
    'asciidoc',
    'asm',
    'bat',
    'c',
    'cc',
    'cpp',
    'css',
    'csv',
    'conf',
    'config',
    'dart',
    'env',
    'go',
    'gradle',
    'groovy',
    'h',
    'html',
    'ini',
    'java',
    'js',
    'json',
    'jsx',
    'kotlin',
    'less',
    'license',
    'log',
    'lua',
    'markdown',
    'md',
    'mjs',
    'php',
    'pl',
    'properties',
    'ps1',
    'py',
    'rb',
    'readme',
    'rst',
    'rust',
    'sass',
    'scala',
    'scss',
    'sh',
    'sql',
    'srt',
    'styl',
    'svg',
    'swift',
    'textile',
    'toml',
    'ts',
    'tsx',
    'tsv',
    'txt',
    'vue',
    'wiki',
    'xml',
    'yaml',
    'yml',
  ]
  const isEditable =
    canEdit &&
    (document?.source_type === 'text' ||
      (document?.source_type === 'file' &&
        editableExtensions.includes(document?.file_extension?.toLowerCase() || '')))

  // Track if content has changed (compare against content at edit start)
  const hasChanges = editedContent !== (editStartContentRef.current || detail?.content || '')

  // Check if content should be rendered as markdown (based on file extension or content detection)
  const isMarkdownContent = useMemo(() => {
    if (!fullContent) return false
    return isMarkdownFileExtension(document?.file_extension) || containsMarkdownSyntax(fullContent)
  }, [fullContent, document?.file_extension])

  // Reset editing state when dialog closes or document changes
  useEffect(() => {
    if (!open) {
      setIsEditing(false)
      setEditedContent('')
      setIsFullscreen(false)
    }
  }, [open])

  // Reset fullscreen when exiting edit mode
  useEffect(() => {
    if (!isEditing) {
      setIsFullscreen(false)
    }
  }, [isEditing])

  // Build the full accessible URL using virtual path (no kbId):
  // Uses buildKbUrl to generate the correct format based on KB type:
  //   - personal (namespace="default"): /knowledge/default/{kbName}/{docPath}
  //   - organization: /knowledge/public/{kbName}/{docPath}
  //   - team: /knowledge/{namespace}/{kbName}/{docPath}
  const documentFullUrl = document
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${buildKbUrl(knowledgeBaseNamespace, knowledgeBaseName, isOrganization, document.name)}`
    : null

  const handleCopyLink = async () => {
    if (!documentFullUrl) return
    try {
      await navigator.clipboard.writeText(documentFullUrl)
      setCopiedLink(true)
      toast.success(t('document.document.detail.copyLinkSuccess', { defaultValue: 'Link copied' }))
      setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      toast.error(
        t('document.document.detail.copyLinkError', { defaultValue: 'Failed to copy link' })
      )
    }
  }

  const handleCopyContent = async () => {
    // Prefer fullContent when available, fall back to detail.content
    const contentToCopy = fullContent || detail?.content
    if (!contentToCopy) return
    try {
      await navigator.clipboard.writeText(contentToCopy)
      setCopiedContent(true)
      toast.success(t('document.document.detail.copySuccess'))
      setTimeout(() => setCopiedContent(false), 2000)
    } catch {
      toast.error(t('document.document.detail.copyError'))
    }
  }

  const handleRefresh = () => {
    refresh()
  }

  const handleEdit = useCallback(async () => {
    if (!isEditable) return

    // If there's more content to load, load it first before editing
    let contentToEdit = fullContent || detail?.content || ''
    if (hasMoreContent) {
      setIsLoadingFullContent(true)
      try {
        const result = await loadAllContent()
        if (result) {
          // Use fresh values from result to avoid stale closure issues
          if (result.hasMore || result.loading) {
            // Content is still incomplete, bail out without opening editor
            return
          }
          contentToEdit = result.content
        }
      } finally {
        setIsLoadingFullContent(false)
      }
    }

    setEditedContent(contentToEdit)
    // Store the content at edit start for accurate change detection
    editStartContentRef.current = contentToEdit
    setIsEditing(true)
  }, [isEditable, hasMoreContent, loadAllContent, fullContent, detail?.content])

  const handleSave = async () => {
    if (!document || !isEditable) return

    setIsSaving(true)
    try {
      await knowledgeBaseApi.updateDocumentContent(document.id, editedContent)
      toast.success(t('document.document.detail.saveSuccess'))
      setIsEditing(false)
      // Refresh to get the updated content
      refresh()
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t('document.document.detail.saveFailed')
      toast.error(errorMessage)
    } finally {
      setIsSaving(false)
    }
  }

  // Handle save from Vim :w command - receives content from WysiwygEditor
  const handleVimSave = useCallback(
    async (content: string) => {
      if (!document || !isEditable) return

      setIsSaving(true)
      try {
        await knowledgeBaseApi.updateDocumentContent(document.id, content)
        // Update local state to match saved content
        setEditedContent(content)
        // Update the edit start content ref so hasChanges becomes false
        editStartContentRef.current = content
        toast.success(t('document.document.detail.saveSuccess'))
        // Refresh to get the updated content
        refresh()
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t('document.document.detail.saveFailed')
        toast.error(errorMessage)
      } finally {
        setIsSaving(false)
      }
    },
    [document, isEditable, t, refresh]
  )

  const handleCancel = useCallback(() => {
    if (hasChanges) {
      setShowDiscardDialog(true)
    } else {
      setIsEditing(false)
    }
  }, [hasChanges])

  const handleDiscardChanges = () => {
    setShowDiscardDialog(false)
    setIsEditing(false)
    setEditedContent('')
    editStartContentRef.current = ''
  }

  const handleContentChange = useCallback((content: string) => {
    setEditedContent(content)
  }, [])

  if (!document) return null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'flex flex-col p-0',
            isFullscreen
              ? 'max-w-[100vw] w-[100vw] max-h-[100vh] h-[100vh] rounded-none'
              : 'max-w-4xl max-h-[85vh]'
          )}
          hideCloseButton={isFullscreen}
          preventEscapeClose={isEditing}
          preventOutsideClick={true}
        >
          {/* Header - hidden in fullscreen mode */}
          {!isFullscreen && (
            <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0 mt-0.5">
                  <FileText className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base font-medium text-text-primary truncate">
                    {document.name}
                  </DialogTitle>
                  <DialogDescription className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                    <span>{document.file_extension.toUpperCase()}</span>
                    <span>•</span>
                    <span>
                      {new Date(document.created_at).toLocaleDateString(getCurrentLanguage(), {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </span>
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          )}

          {/* Content */}
          <div
            className={cn(
              'flex-1 px-6 py-4',
              isEditing && isFullscreen ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
              isEditing && !isFullscreen && 'flex flex-col'
            )}
          >
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
                <p className="mb-4">{error}</p>
                <Button variant="outline" onClick={handleRefresh}>
                  {t('common:actions.retry')}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  isEditing && isFullscreen ? 'flex-1 flex flex-col h-full' : 'space-y-6',
                  isEditing && !isFullscreen && 'flex-1 flex flex-col space-y-6'
                )}
              >
                {/* Summary Section - only show when not editing */}
                {!isEditing && detail?.summary && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-text-primary">
                        {t('document.document.detail.summary')}
                      </h3>
                      <Button variant="ghost" size="sm" onClick={handleRefresh}>
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                    </div>

                    {/* Summary Status */}
                    {detail.summary.status && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">
                          {t('document.document.detail.status')}:
                        </span>
                        <Badge
                          variant={
                            detail.summary.status === 'completed'
                              ? 'success'
                              : detail.summary.status === 'generating'
                                ? 'warning'
                                : 'default'
                          }
                          size="sm"
                        >
                          {t(`document.document.detail.statusValues.${detail.summary.status}`)}
                        </Badge>
                      </div>
                    )}

                    {/* Short Summary */}
                    {detail.summary.short_summary && (
                      <div className="p-3 bg-surface rounded-lg">
                        <p className="text-sm text-text-primary">{detail.summary.short_summary}</p>
                      </div>
                    )}

                    {/* Long Summary */}
                    {detail.summary.long_summary && (
                      <div className="p-3 bg-surface rounded-lg">
                        <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                          {detail.summary.long_summary}
                        </p>
                      </div>
                    )}

                    {/* Topics */}
                    {detail.summary.topics && detail.summary.topics.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-xs text-text-muted">
                          {t('document.document.detail.topics')}:
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {detail.summary.topics.map((topic, index) => (
                            <Badge key={index} variant="secondary" size="sm">
                              {topic}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Chunks Section - only show when not editing and chunk storage is enabled */}
                {!isEditing && document && chunkStorageEnabled && (
                  <ChunksSection documentId={document.id} enabled={open && !loading} />
                )}

                {/* Content Section */}
                {detail?.content !== undefined && (
                  <div
                    className={cn(
                      isEditing && isFullscreen ? 'flex-1 flex flex-col h-full' : 'space-y-3',
                      isEditing && !isFullscreen && 'space-y-3 flex-1 flex flex-col'
                    )}
                  >
                    <div className="flex items-center justify-between flex-shrink-0">
                      {/* Content title - hidden in fullscreen mode */}
                      {!isFullscreen && (
                        <h3 className="text-sm font-medium text-text-primary">
                          {t('document.document.detail.content')}
                        </h3>
                      )}
                      {/* In fullscreen mode, show document name instead */}
                      {isFullscreen && (
                        <span className="text-sm font-medium text-text-primary truncate max-w-[50%]">
                          {document.name}
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        {!isEditing && hasMoreContent && (
                          <Badge variant="warning" size="sm">
                            {t('document.document.detail.truncated')}
                          </Badge>
                        )}
                        {isEditing ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setIsFullscreen(!isFullscreen)}
                                >
                                  {isFullscreen ? (
                                    <Minimize2 className="w-3.5 h-3.5" />
                                  ) : (
                                    <Maximize2 className="w-3.5 h-3.5" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isFullscreen
                                  ? t('document.document.detail.exitFullscreen')
                                  : t('document.document.detail.fullscreen')}
                              </TooltipContent>
                            </Tooltip>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleCancel}
                              disabled={isSaving}
                            >
                              <X className="w-3.5 h-3.5 mr-1" />
                              {t('document.document.detail.cancel')}
                            </Button>
                            <Button size="sm" onClick={handleSave} disabled={isSaving}>
                              {isSaving ? (
                                <>
                                  <Spinner className="w-3.5 h-3.5 mr-1" />
                                  {t('document.document.detail.saving')}
                                </>
                              ) : (
                                <>
                                  <Save className="w-3.5 h-3.5 mr-1" />
                                  {t('document.document.detail.save')}
                                </>
                              )}
                            </Button>
                          </>
                        ) : (
                          <>
                            {/* View mode toggle - show for markdown or JSON content */}
                            {(isMarkdownContent || isJsonContent) && fullContent && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      setViewMode(viewMode === 'preview' ? 'raw' : 'preview')
                                    }
                                  >
                                    {viewMode === 'preview' ? (
                                      <Code className="w-3.5 h-3.5" />
                                    ) : (
                                      <Eye className="w-3.5 h-3.5" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {viewMode === 'preview'
                                    ? t('document.document.detail.viewRaw')
                                    : t('document.document.detail.viewPreview')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {/* Copy link button - always visible in preview mode */}
                            {documentFullUrl && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleCopyLink}
                                    disabled={copiedLink}
                                  >
                                    {copiedLink ? (
                                      <Check className="w-3.5 h-3.5" />
                                    ) : (
                                      <svg
                                        className="w-3.5 h-3.5"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                      </svg>
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="max-w-xs break-all">
                                    {copiedLink
                                      ? t('document.document.detail.copied')
                                      : documentFullUrl}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {isEditable && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleEdit}
                                disabled={isLoadingFullContent || loadingMore}
                              >
                                {isLoadingFullContent || loadingMore ? (
                                  <>
                                    <Spinner className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.loading', {
                                      defaultValue: 'Loading...',
                                    })}
                                  </>
                                ) : (
                                  <>
                                    <Pencil className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.edit')}
                                  </>
                                )}
                              </Button>
                            )}
                            {detail.content && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleCopyContent}
                                disabled={copiedContent}
                              >
                                {copiedContent ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.copied')}
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.copy')}
                                  </>
                                )}
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <div
                        className={cn(
                          'flex-1 flex flex-col',
                          isFullscreen ? 'h-full mt-3' : 'mt-3'
                        )}
                      >
                        <WysiwygEditor
                          initialContent={editedContent}
                          onChange={handleContentChange}
                          onSave={handleVimSave}
                          className={cn(isFullscreen ? 'flex-1' : 'min-h-[400px]')}
                          language={getEditorLanguage(document.file_extension)}
                        />
                      </div>
                    ) : fullContent ? (
                      <div className="p-4 bg-white rounded-lg border border-border">
                        {/* Render based on content type and view mode */}
                        {isMarkdownContent && viewMode === 'preview' ? (
                          <EnhancedMarkdown
                            source={fullContent}
                            theme={theme}
                            components={{
                              a: ({
                                href,
                                children,
                                ...props
                              }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
                                children?: React.ReactNode
                              }) => {
                                if (!href) {
                                  return <a {...props}>{children}</a>
                                }
                                // Check if this is a wiki link (relative path or absolute virtual path)
                                // Absolute virtual paths start with "/" but are NOT external URLs
                                const isExternalUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
                                const isAnchor = href.startsWith('#')
                                const isWikiLink = !isExternalUrl && !isAnchor
                                if (!isWikiLink) {
                                  // Absolute URL - open in new tab
                                  return (
                                    <a
                                      href={href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-primary hover:underline"
                                      {...props}
                                    >
                                      {children}
                                    </a>
                                  )
                                }
                                // Relative wiki link - resolve and navigate
                                const handleClick = async (
                                  e: React.MouseEvent<HTMLButtonElement>
                                ) => {
                                  e.preventDefault()
                                  const url = await resolveWikiLink(
                                    href,
                                    knowledgeBaseId,
                                    document.name,
                                    knowledgeBaseName,
                                    knowledgeBaseNamespace,
                                    isOrganization
                                  )
                                  if (url) {
                                    router.push(url)
                                    onOpenChange(false)
                                  } else {
                                    toast.error(
                                      t('document.document.detail.linkNotFound', {
                                        defaultValue: `Knowledge base not found: ${href}`,
                                      })
                                    )
                                  }
                                }
                                return (
                                  <button
                                    type="button"
                                    onClick={handleClick}
                                    className="text-primary hover:underline cursor-pointer inline bg-transparent border-none p-0 font-inherit"
                                    title={decodeURIComponent(href)}
                                  >
                                    {children}
                                  </button>
                                )
                              },
                            }}
                          />
                        ) : (
                          <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                            {/* For JSON content in preview mode, show formatted JSON if valid */}
                            {/* For JSON content in raw mode, show raw content */}
                            {/* For other content, always show raw */}
                            {isJsonContent && viewMode === 'preview' && formattedJsonContent
                              ? formattedJsonContent
                              : fullContent}
                          </pre>
                        )}
                        {/* Content length and truncation info */}
                        <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted flex items-center justify-between">
                          <span>
                            {detail?.content_length !== undefined && (
                              <>
                                {t('document.document.detail.contentLength')}:{' '}
                                {fullContent.length.toLocaleString()}
                                {hasMoreContent && detail.content_length > fullContent.length
                                  ? ` / ${detail.content_length.toLocaleString()}`
                                  : ''}{' '}
                                {t('document.document.detail.characters')}
                              </>
                            )}
                          </span>
                          {/* Load more button */}
                          {hasMoreContent && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={loadMore}
                              disabled={loadingMore}
                              data-testid="load-more-button"
                              className="h-11 min-w-[44px]"
                            >
                              {loadingMore ? (
                                <>
                                  <Spinner className="w-3 h-3 mr-1" />
                                  {t('document.document.detail.loadingMore', {
                                    defaultValue: 'Loading...',
                                  })}
                                </>
                              ) : (
                                <>
                                  {t('document.document.detail.loadMore', {
                                    defaultValue: 'Load More',
                                  })}
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
                        {t('document.document.detail.noContent')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Discard Changes Confirmation Dialog */}
      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('document.document.detail.discardChanges')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('document.document.detail.unsavedChanges')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardChanges}>
              {t('document.document.detail.discardChanges')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
