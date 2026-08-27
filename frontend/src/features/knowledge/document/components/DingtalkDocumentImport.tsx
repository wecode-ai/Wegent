// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import type { DingtalkDocNode, DingtalkSyncStatus } from '@/types/dingtalk-doc'
import { cn } from '@/lib/utils'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'
import { FolderSelect } from './FolderSelect'

// Maximum documents one batch import may create; mirrors the backend cap.
const MAX_IMPORT_DOCUMENTS = 50

type DingtalkSourceKey = 'docs' | 'wikispace'

export interface DingtalkBatchImportSummary {
  createdCount: number
  updatedCount: number
  processingCount: number
}

interface SourceState {
  nodes: DingtalkDocNode[]
  status: DingtalkSyncStatus | null
  loading: boolean
  loaded: boolean
  notConfigured: boolean
  loadFailed: boolean
  refreshFailed: boolean
  refreshing: boolean
}

const EMPTY_SOURCE: SourceState = {
  nodes: [],
  status: null,
  loading: false,
  loaded: false,
  notConfigured: false,
  loadFailed: false,
  refreshFailed: false,
  refreshing: false,
}

function flattenTree(nodes: DingtalkDocNode[]): DingtalkDocNode[] {
  const result: DingtalkDocNode[] = []
  const walk = (items: DingtalkDocNode[]) => {
    for (const item of items) {
      result.push(item)
      if (item.children?.length) walk(item.children)
    }
  }
  walk(nodes)
  return result
}

function collectDocIds(node: DingtalkDocNode): string[] {
  const ids: string[] = []
  if (node.node_type === 'doc') ids.push(node.dingtalk_node_id)
  for (const child of node.children ?? []) ids.push(...collectDocIds(child))
  return ids
}

// Selection key for one node: docs and folders get distinct prefixes so a
// folder and a same-ID document never collide in the selection set.
function nodeKey(node: DingtalkDocNode): string {
  return `${node.node_type === 'folder' ? 'folder' : 'doc'}:${node.dingtalk_node_id}`
}

// Expand the selected docs/folders into the deduplicated document IDs that
// will actually be imported. Folders resolve to their importable descendant
// documents at submit time; the source folder structure is never copied.
// Both directory sources are walked so a selection survives switching tabs.
function expandSelection(nodes: DingtalkDocNode[], selectedKeys: Set<string>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const addAll = (ids: string[]) => {
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push(id)
      }
    }
  }
  const walk = (node: DingtalkDocNode): void => {
    if (node.node_type === 'doc' && selectedKeys.has(nodeKey(node))) {
      addAll([node.dingtalk_node_id])
    }
    if (node.node_type === 'folder' && selectedKeys.has(nodeKey(node))) {
      addAll(collectDocIds(node))
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of nodes) walk(node)
  return result
}

function formatLastSynced(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

interface DingtalkDocumentImportProps {
  /** Return to the upload source picker */
  onBack: () => void
  /** Batch-import the expanded document IDs; resolves with the submit result */
  onImport: (resourceIds: string[]) => Promise<DingtalkBatchImportSummary>
  /** Called after the user acknowledges the import result */
  onDone?: () => void
  /** Currently selected folder ID for import destination (0 = root) */
  folderId?: number
  /** Flat list of folder names with IDs for the selector */
  folderOptions?: Array<{ id: number; name: string; depth: number }>
  /** Callback when folder selection changes */
  onFolderChange?: (folderId: number) => void
  /** Whether the current knowledge base is shared with other members */
  isSharedKnowledgeBase?: boolean
  /** Whether the user may manage documents in the current knowledge base */
  canManageDocuments?: boolean
}

export function DingtalkDocumentImport({
  onBack,
  onImport,
  onDone,
  folderId = 0,
  folderOptions = [],
  onFolderChange,
  isSharedKnowledgeBase = false,
  canManageDocuments = true,
}: DingtalkDocumentImportProps) {
  const { t } = useTranslation('knowledge')
  const [activeSource, setActiveSource] = useState<DingtalkSourceKey>('docs')
  const [sources, setSources] = useState<Record<DingtalkSourceKey, SourceState>>({
    docs: EMPTY_SOURCE,
    wikispace: EMPTY_SOURCE,
  })
  const [path, setPath] = useState<DingtalkDocNode[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [result, setResult] = useState<DingtalkBatchImportSummary | null>(null)

  const source = sources[activeSource]

  const setSourceState = useCallback((key: DingtalkSourceKey, patch: Partial<SourceState>) => {
    setSources(current => ({ ...current, [key]: { ...current[key], ...patch } }))
  }, [])

  // Load the cached directory for one source; no background refresh, the
  // refresh button is the only trigger that pulls from the provider.
  const loadSource = useCallback(
    async (key: DingtalkSourceKey): Promise<boolean> => {
      setSourceState(key, { loading: true, loadFailed: false })
      try {
        const status =
          key === 'docs'
            ? await dingtalkDocApi.getSyncStatus()
            : await dingtalkDocApi.getWikispaceSyncStatus()
        if (!status.is_configured) {
          setSourceState(key, {
            loading: false,
            loaded: true,
            notConfigured: true,
            nodes: [],
            status,
          })
          return true
        }
        const tree =
          key === 'docs' ? await dingtalkDocApi.getDocs() : await dingtalkDocApi.getWikispaceNodes()
        setSourceState(key, {
          loading: false,
          loaded: true,
          notConfigured: false,
          nodes: tree.nodes,
          status,
        })
        return true
      } catch {
        // Keep whatever was loaded before; only the error flag flips.
        setSourceState(key, { loading: false, loaded: true, loadFailed: true })
        return false
      }
    },
    [setSourceState]
  )

  useEffect(() => {
    if (!sources[activeSource].loaded && !sources[activeSource].loading) {
      loadSource(activeSource)
    }
  }, [activeSource, sources, loadSource])

  const handleRefresh = useCallback(async () => {
    setSourceState(activeSource, { refreshFailed: false, refreshing: true })
    try {
      if (activeSource === 'docs') {
        await dingtalkDocApi.syncDocs()
      } else {
        await dingtalkDocApi.syncWikispaceNodes()
      }
      const loaded = await loadSource(activeSource)
      if (!loaded) {
        setSourceState(activeSource, { refreshing: false, refreshFailed: true })
        return
      }
      setPath([])
      setSourceState(activeSource, { refreshing: false })
    } catch {
      // Refresh failed: keep the old directory and the current selection.
      setSourceState(activeSource, { refreshing: false, refreshFailed: true })
    }
  }, [activeSource, loadSource, setSourceState])

  const handleSourceChange = useCallback((key: DingtalkSourceKey) => {
    setActiveSource(key)
    setPath([])
    setSearchQuery('')
  }, [])

  const flattenedNodes = useMemo(() => flattenTree(source.nodes), [source.nodes])

  const visibleNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (query) {
      return flattenedNodes.filter(node => node.name.toLowerCase().includes(query))
    }
    if (path.length === 0) return source.nodes
    return path[path.length - 1].children ?? []
  }, [searchQuery, flattenedNodes, source.nodes, path])

  // Selections are counted across both directory sources so a selection made
  // on one tab is neither lost nor silently dropped when submitting on the
  // other tab.
  const expandedIds = useMemo(
    () => expandSelection([...sources.docs.nodes, ...sources.wikispace.nodes], selectedKeys),
    [sources.docs.nodes, sources.wikispace.nodes, selectedKeys]
  )
  const overLimit = expandedIds.length > MAX_IMPORT_DOCUMENTS

  const toggleSelect = useCallback((node: DingtalkDocNode) => {
    setSelectedKeys(current => {
      const key = nodeKey(node)
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const canSubmit =
    canManageDocuments && !submitting && expandedIds.length > 0 && !overLimit && result === null

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const summary = await onImport(expandedIds)
      setResult(summary)
    } catch (err) {
      setSubmitError(mapKnowledgeDocumentErrorMessage(err, t, 'document.upload.dingtalk.addFailed'))
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, onImport, expandedIds, t])

  const handleDone = useCallback(() => {
    onDone?.()
  }, [onDone])

  // While the submit result is on screen, directory load/refresh errors are
  // stale — only a submit error may still surface alongside the result.
  const errorText =
    result !== null
      ? null
      : (submitError ??
        (source.refreshFailed ? t('document.upload.dingtalk.refreshFailed') : null) ??
        (source.loadFailed ? t('document.upload.dingtalk.loadFailed') : null))

  const searchActive = searchQuery.trim().length > 0

  const renderNodeRow = (node: DingtalkDocNode) => {
    const importable = node.node_type === 'doc'
    const selectable = importable || node.node_type === 'folder'
    const selected = selectedKeys.has(nodeKey(node))
    const rowTestId =
      node.node_type === 'folder'
        ? `dingtalk-folder-option-${node.dingtalk_node_id}`
        : `dingtalk-document-option-${node.dingtalk_node_id}`
    return (
      <div
        key={node.dingtalk_node_id}
        className="flex items-center gap-3 p-3"
        data-testid={rowTestId}
      >
        {selectable ? (
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors"
            onClick={() => toggleSelect(node)}
            disabled={submitting || result !== null}
            aria-label={node.name}
            data-testid={`dingtalk-node-select-${node.dingtalk_node_id}`}
          >
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded border transition-colors',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:border-primary'
              )}
            >
              {selected && <Check className="h-3.5 w-3.5" />}
            </span>
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0 flex items-center justify-center">
            <span className="h-5 w-5" />
          </span>
        )}
        {node.node_type === 'folder' ? (
          <Folder className="w-4 h-4 text-primary flex-shrink-0" />
        ) : (
          <FileText
            className={cn(
              'w-4 h-4 flex-shrink-0',
              importable ? 'text-primary' : 'text-text-secondary'
            )}
          />
        )}
        <span
          className={cn(
            'flex-1 truncate text-sm',
            selectable ? 'text-text-primary' : 'text-text-secondary'
          )}
        >
          {node.name}
        </span>
        {node.node_type === 'folder' && !searchActive && (
          <Button
            variant="ghost"
            className="h-11 w-11 shrink-0 p-0"
            onClick={() => setPath(current => [...current, node])}
            disabled={submitting || result !== null}
            data-testid={`dingtalk-folder-navigate-${node.dingtalk_node_id}`}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        )}
        {!selectable && (
          <span
            className="text-xs text-text-secondary"
            data-testid={`dingtalk-node-unsupported-${node.dingtalk_node_id}`}
          >
            {t('document.upload.dingtalk.unsupported')}
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      <DialogHeader className="flex flex-row items-center gap-2 space-y-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={onBack}
          disabled={submitting}
          data-testid="dingtalk-import-back"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <DialogTitle>{t('document.upload.dingtalk.title')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 space-y-4">
        <p className="text-sm text-text-secondary">{t('document.upload.dingtalk.hint')}</p>

        {isSharedKnowledgeBase && (
          <div
            className="flex items-center gap-2 p-3 bg-surface rounded-lg text-sm text-text-secondary"
            data-testid="dingtalk-import-shared-hint"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{t('document.upload.dingtalk.sharedHint')}</span>
          </div>
        )}

        {result !== null ? (
          <div
            className="flex items-center gap-2 p-3 bg-surface rounded-lg text-sm"
            data-testid="dingtalk-import-result"
          >
            <Check className="w-4 h-4 text-primary flex-shrink-0" />
            <span>
              {t('document.upload.dingtalk.result', {
                created: result.createdCount,
                updated: result.updatedCount,
                processing: result.processingCount,
              })}
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-border p-0.5">
                {(Object.keys(sources) as DingtalkSourceKey[]).map(key => (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      'h-11 rounded-md px-3 text-sm transition-colors',
                      activeSource === key
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-text-secondary hover:text-text-primary'
                    )}
                    onClick={() => handleSourceChange(key)}
                    data-testid={
                      key === 'docs'
                        ? 'dingtalk-import-tab-my-docs'
                        : 'dingtalk-import-tab-wikispace'
                    }
                  >
                    {t(
                      key === 'docs'
                        ? 'document.upload.dingtalk.myDocs'
                        : 'document.upload.dingtalk.wikispace'
                    )}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <Button
                variant="outline"
                className="h-11 gap-1.5"
                onClick={handleRefresh}
                disabled={source.refreshing || source.loading}
                data-testid="dingtalk-import-refresh"
              >
                {source.refreshing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {source.refreshing
                  ? t('document.upload.dingtalk.refreshing')
                  : t('document.upload.dingtalk.refresh')}
              </Button>
            </div>

            {source.status?.last_synced_at && (
              <p className="text-xs text-text-secondary" data-testid="dingtalk-import-last-synced">
                {t('document.upload.dingtalk.lastSynced')}:{' '}
                {formatLastSynced(source.status.last_synced_at)}
              </p>
            )}

            {!source.notConfigured && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
                <Input
                  className="h-11 pl-9"
                  placeholder={t('document.upload.dingtalk.searchPlaceholder')}
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  disabled={submitting}
                  data-testid="dingtalk-import-search"
                />
              </div>
            )}

            {source.loading && (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-text-secondary">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('document.upload.dingtalk.loading')}
              </div>
            )}

            {!source.loading && source.notConfigured && (
              <div className="flex items-center gap-2 p-3 bg-surface rounded-lg text-sm text-text-secondary">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>
                  {activeSource === 'docs'
                    ? t('document.upload.dingtalk.notConfigured')
                    : t('document.upload.dingtalk.wikispaceNotConfigured')}
                </span>
              </div>
            )}

            {!source.loading && !source.notConfigured && visibleNodes.length === 0 && (
              <div className="p-3 bg-surface rounded-lg text-sm text-text-secondary">
                {t('document.upload.dingtalk.empty')}
              </div>
            )}

            {!source.loading && !source.notConfigured && visibleNodes.length > 0 && (
              <>
                {!searchActive && path.length > 0 && (
                  <div
                    className="flex items-center gap-1 text-sm"
                    data-testid="dingtalk-import-breadcrumb"
                  >
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center text-text-secondary hover:text-text-primary"
                      onClick={() => setPath([])}
                      data-testid="dingtalk-import-breadcrumb-root"
                    >
                      {t(
                        activeSource === 'docs'
                          ? 'document.upload.dingtalk.myDocs'
                          : 'document.upload.dingtalk.wikispace'
                      )}
                    </button>
                    {path.map((node, index) => (
                      <span key={node.dingtalk_node_id} className="flex items-center gap-1">
                        <ChevronRight className="w-3.5 h-3.5 text-text-secondary" />
                        <span
                          className={
                            index === path.length - 1 ? 'text-text-primary' : 'text-text-secondary'
                          }
                        >
                          {node.name}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                <div
                  className="border border-border rounded-lg divide-y divide-border max-h-[260px] overflow-y-auto"
                  data-testid="dingtalk-document-list"
                >
                  {visibleNodes.map(renderNodeRow)}
                </div>
              </>
            )}

            <div
              className="flex items-center gap-2 text-sm"
              data-testid="dingtalk-import-selected-count"
            >
              <span className="font-medium">
                {t('document.upload.dingtalk.selectedCount', {
                  count: expandedIds.length,
                })}
              </span>
            </div>

            {overLimit && (
              <div
                className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm"
                data-testid="dingtalk-import-limit-error"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{t('document.upload.dingtalk.limitError')}</span>
              </div>
            )}

            {!canManageDocuments && (
              <div
                className="flex items-center gap-2 p-3 bg-surface rounded-lg text-sm text-text-secondary"
                data-testid="dingtalk-import-no-permission"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{t('document.upload.dingtalk.noPermission')}</span>
              </div>
            )}

            <FolderSelect
              folderId={folderId}
              folderOptions={folderOptions}
              onFolderChange={onFolderChange}
              triggerTestId="dingtalk-import-folder-select"
            />
          </>
        )}

        {errorText && (
          <div
            className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm"
            data-testid="dingtalk-import-error"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorText}</span>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {result !== null ? (
          <Button
            variant="primary"
            className="min-h-11"
            onClick={handleDone}
            data-testid="dingtalk-import-done"
          >
            {t('document.upload.dingtalk.done')}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={onBack}
              disabled={submitting}
              data-testid="dingtalk-import-cancel"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              className="min-h-11"
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="dingtalk-import-submit"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('document.upload.adding')}
                </>
              ) : (
                t('document.upload.dingtalk.submitButton')
              )}
            </Button>
          </>
        )}
      </div>
    </>
  )
}
