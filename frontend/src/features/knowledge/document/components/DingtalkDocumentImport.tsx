// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Check,
  BookOpen,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import type { DingtalkDocNode, DingtalkSyncStatus } from '@/types/dingtalk-doc'
import { cn } from '@/lib/utils'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'
import { DingtalkImportTree, collectImportableIds, filterImportTree } from './DingtalkImportTree'
import { useExternalImportStatuses } from '../hooks/useExternalImportStatuses'

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

function formatLastSynced(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

interface DingtalkDocumentImportProps {
  knowledgeBaseId: number
  /** Batch-import the expanded document IDs; resolves with the submit result */
  onImport: (resourceIds: string[]) => Promise<DingtalkBatchImportSummary>
  /** Called after the user acknowledges the import result */
  onDone?: () => void
  onDraftChange: (hasDraft: boolean) => void
  renderFooter: (action: ReactNode, status?: ReactNode) => ReactNode
  /** Whether the user may manage documents in the current knowledge base */
  canManageDocuments?: boolean
}

export function DingtalkDocumentImport({
  knowledgeBaseId,
  onImport,
  onDone,
  onDraftChange,
  renderFooter,
  canManageDocuments = true,
}: DingtalkDocumentImportProps) {
  const { t } = useTranslation('knowledge')
  const [activeSource, setActiveSource] = useState<DingtalkSourceKey>('docs')
  const [sources, setSources] = useState<Record<DingtalkSourceKey, SourceState>>({
    docs: EMPTY_SOURCE,
    wikispace: EMPTY_SOURCE,
  })
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [result, setResult] = useState<DingtalkBatchImportSummary | null>(null)
  useEffect(() => {
    onDraftChange(result === null && selectedIds.size > 0)
  }, [onDraftChange, result, selectedIds])

  const resultItems = result
    ? [
        result.createdCount > 0 &&
          t('document.upload.dingtalk.resultCreated', { count: result.createdCount }),
        result.updatedCount > 0 &&
          t('document.upload.dingtalk.resultUpdated', { count: result.updatedCount }),
        result.processingCount > 0 &&
          t('document.upload.dingtalk.resultProcessing', { count: result.processingCount }),
      ].filter(Boolean)
    : []

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
      setSourceState(activeSource, { refreshing: false })
    } catch {
      // Refresh failed: keep the old directory and the current selection.
      setSourceState(activeSource, { refreshing: false, refreshFailed: true })
    }
  }, [activeSource, loadSource, setSourceState])

  const handleSourceChange = useCallback((key: DingtalkSourceKey) => {
    setActiveSource(key)
  }, [])

  const visibleNodes = useMemo(
    () => filterImportTree(source.nodes, searchQuery),
    [source.nodes, searchQuery]
  )
  const availableIds = useMemo(
    () => [
      ...new Set(
        Object.values(sources).flatMap(item => collectImportableIds(item.nodes, '', item.status))
      ),
    ],
    [sources]
  )
  const importStatuses = useExternalImportStatuses(knowledgeBaseId, availableIds)
  const refreshImportStatuses = importStatuses.retry
  // A directory refresh can remove documents, but must never add new ones to a selection.
  useEffect(() => {
    const available = new Set(availableIds)
    setSelectedIds(current => {
      const next = new Set([...current].filter(id => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [availableIds])
  const expandedIds = availableIds.filter(id => selectedIds.has(id))
  const overLimit = expandedIds.length > MAX_IMPORT_DOCUMENTS
  // Ancestor documents retained for context are not search matches themselves.
  const visibleIds = collectImportableIds(visibleNodes, searchQuery, source.status)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))

  const toggleSelect = useCallback((ids: string[]) => {
    setSelectedIds(current => {
      const next = new Set(current)
      const clear = ids.every(id => next.has(id))
      ids.forEach(id => (clear ? next.delete(id) : next.add(id)))
      return next
    })
  }, [])
  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const canSubmit =
    canManageDocuments &&
    !source.notConfigured &&
    !submitting &&
    expandedIds.length > 0 &&
    !overLimit &&
    result === null

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const summary = await onImport(expandedIds)
      setSelectedIds(new Set())
      setResult(summary)
    } catch (err) {
      setSubmitError(mapKnowledgeDocumentErrorMessage(err, t, 'document.upload.dingtalk.addFailed'))
    } finally {
      // A failed batch may also have created some copies before returning an error.
      refreshImportStatuses()
      setSubmitting(false)
    }
  }, [canSubmit, onImport, expandedIds, t, refreshImportStatuses])

  const handleDone = useCallback(() => {
    setResult(null)
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

  return (
    <>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-5 py-3 max-md:overflow-y-auto [@media(max-height:640px)]:overflow-y-auto',
          result !== null && 'overflow-y-auto'
        )}
      >
        <div className="flex shrink-0 items-center text-xs text-text-secondary">
          <p>
            {t('document.upload.dingtalk.compactHint')} ·{' '}
            <span data-testid="dingtalk-import-shared-hint">
              {t('document.upload.dingtalk.sharedHint')}
            </span>
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className="h-11 w-11 shrink-0 p-0"
                aria-label={t('document.upload.dingtalk.help')}
                data-testid="dingtalk-import-help"
              >
                <Info className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="space-y-2 text-sm">
              <p>{t('document.upload.dingtalk.hint')}</p>
              {source.status?.last_synced_at && (
                <p
                  className="text-xs text-text-secondary"
                  data-testid="dingtalk-import-last-synced"
                >
                  {t('document.upload.dingtalk.lastSynced')}:{' '}
                  {formatLastSynced(source.status.last_synced_at)}
                </p>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {result !== null ? (
          resultItems.length > 0 && (
            <div
              className="flex shrink-0 items-start gap-2 rounded-lg bg-surface p-3 text-sm"
              data-testid="dingtalk-import-result"
            >
              <Check className="w-4 h-4 text-primary flex-shrink-0" />
              <span>{resultItems.join(t('document.upload.dingtalk.resultSeparator'))}</span>
            </div>
          )
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col border-t border-border md:flex-row max-md:flex-none [@media(max-height:640px)]:flex-none">
              <nav
                aria-label={t('document.upload.dingtalk.sourceNavigation')}
                className="flex shrink-0 gap-1 border-b border-border py-2 md:w-44 md:flex-col md:border-b-0 md:border-r md:pr-2"
                data-testid="dingtalk-import-source-navigation"
              >
                {(Object.keys(sources) as DingtalkSourceKey[]).map(key => {
                  const Icon = key === 'docs' ? FileText : BookOpen
                  const count = collectImportableIds(
                    sources[key].nodes,
                    '',
                    sources[key].status
                  ).filter(id => selectedIds.has(id)).length
                  return (
                    <button
                      key={key}
                      type="button"
                      className={cn(
                        'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm md:flex-none',
                        activeSource === key
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-text-primary hover:bg-surface'
                      )}
                      aria-pressed={activeSource === key}
                      onClick={() => handleSourceChange(key)}
                      disabled={submitting}
                      data-testid={
                        key === 'docs'
                          ? 'dingtalk-import-tab-my-docs'
                          : 'dingtalk-import-tab-wikispace'
                      }
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={t(
                          key === 'docs'
                            ? 'document.upload.dingtalk.myDocs'
                            : 'document.upload.dingtalk.wikispace'
                        )}
                      >
                        {t(
                          key === 'docs'
                            ? 'document.upload.dingtalk.myDocs'
                            : 'document.upload.dingtalk.wikispace'
                        )}
                      </span>
                      {count > 0 && (
                        <span
                          className="rounded-full bg-surface px-1.5 text-xs text-text-secondary"
                          aria-label={t('document.upload.dingtalk.selectedCount', { count })}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </nav>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col md:pl-2">
                <div className="flex shrink-0 items-center gap-2 py-2">
                  {!source.notConfigured && (
                    <div className="relative min-w-0 flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                      <Input
                        className="h-11 pl-9"
                        aria-label={t('document.upload.dingtalk.searchPlaceholder')}
                        placeholder={t('document.upload.dingtalk.searchPlaceholder')}
                        value={searchQuery}
                        onChange={event => setSearchQuery(event.target.value)}
                        disabled={submitting}
                        data-testid="dingtalk-import-search"
                      />
                    </div>
                  )}
                  {!source.notConfigured && (
                    <Button
                      variant="ghost"
                      className="ml-auto h-11 w-11 shrink-0 p-0"
                      onClick={handleRefresh}
                      disabled={submitting || source.refreshing || source.loading}
                      aria-label={t(
                        source.refreshing
                          ? 'document.upload.dingtalk.refreshing'
                          : 'document.upload.dingtalk.refresh'
                      )}
                      data-testid="dingtalk-import-refresh"
                    >
                      {source.refreshing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
                {source.loading ? (
                  <div className="flex items-center justify-center gap-2 p-6 text-sm text-text-secondary">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('document.upload.dingtalk.loading')}
                  </div>
                ) : source.notConfigured ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3 text-sm text-text-secondary">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                      {t(
                        activeSource === 'docs'
                          ? 'document.upload.dingtalk.notConfigured'
                          : 'document.upload.dingtalk.wikispaceNotConfigured'
                      )}
                    </span>
                    <Button asChild variant="primary" className="min-h-11">
                      <Link
                        href="/settings?tab=integrations"
                        data-testid="dingtalk-go-to-settings-button"
                      >
                        {t('document.goToSettings')}
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 text-xs text-text-secondary">
                      <span>
                        {t(
                          searchActive
                            ? 'document.upload.dingtalk.searchCount'
                            : 'document.upload.dingtalk.documentCount',
                          { count: visibleIds.length }
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        className="min-h-11 text-xs text-primary"
                        disabled={submitting || !visibleIds.length}
                        onClick={() => toggleSelect(visibleIds)}
                        data-testid="dingtalk-import-select-all"
                      >
                        {t(
                          searchActive
                            ? allVisibleSelected
                              ? 'document.upload.dingtalk.clearSearchSelection'
                              : 'document.upload.dingtalk.selectSearchResults'
                            : allVisibleSelected
                              ? 'document.upload.dingtalk.clearSelection'
                              : 'document.upload.dingtalk.selectAll'
                        )}
                      </Button>
                    </div>
                    {searchActive && (
                      <p className="shrink-0 pb-2 text-xs text-text-muted">
                        {t('document.upload.dingtalk.searchSelectionHint')}
                      </p>
                    )}
                    {visibleNodes.length ? (
                      <div
                        className="min-h-0 flex-1 overflow-y-auto max-md:flex-none max-md:overflow-visible [@media(max-height:640px)]:flex-none [@media(max-height:640px)]:overflow-visible"
                        data-testid="dingtalk-document-list"
                      >
                        <DingtalkImportTree
                          importStatuses={importStatuses.statuses}
                          nodes={source.nodes}
                          query={searchQuery}
                          selectedIds={selectedIds}
                          expandedKeys={expandedKeys}
                          disabled={submitting}
                          configuration={source.status}
                          onToggle={toggleSelect}
                          onExpand={toggleExpanded}
                        />
                      </div>
                    ) : (
                      <p className="p-3 text-sm text-text-secondary">
                        {t(
                          searchActive
                            ? 'document.upload.dingtalk.noSearchResults'
                            : 'document.upload.dingtalk.empty'
                        )}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {result === null && (importStatuses.loading || importStatuses.failed) && (
        <div
          className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-text-secondary"
          role="status"
        >
          <span>
            {t(
              importStatuses.failed
                ? 'document.upload.dingtalk.statusLoadFailed'
                : 'document.upload.dingtalk.statusLoading'
            )}
          </span>
          {importStatuses.failed && (
            <Button
              variant="ghost"
              className="min-h-11 shrink-0"
              onClick={importStatuses.retry}
              data-testid="dingtalk-import-status-retry"
            >
              {t('document.upload.dingtalk.statusRetry')}
            </Button>
          )}
        </div>
      )}

      {((result === null && (overLimit || !canManageDocuments)) || errorText) && (
        <div className="shrink-0 space-y-2 px-5 pb-3" role="alert">
          {result === null && overLimit && (
            <div
              className="flex shrink-0 items-center gap-2 p-2 bg-error/10 text-error rounded-lg text-xs"
              data-testid="dingtalk-import-limit-error"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{t('document.upload.dingtalk.limitError')}</span>
            </div>
          )}

          {result === null && !canManageDocuments && (
            <div
              className="flex shrink-0 items-center gap-2 p-2 bg-surface rounded-lg text-xs text-text-secondary"
              data-testid="dingtalk-import-no-permission"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{t('document.upload.dingtalk.noPermission')}</span>
            </div>
          )}
          {errorText && (
            <div
              className="flex shrink-0 items-center gap-2 p-2 bg-error/10 text-error rounded-lg text-xs"
              data-testid="dingtalk-import-error"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorText}</span>
            </div>
          )}
        </div>
      )}

      {renderFooter(
        result !== null ? (
          <Button
            variant="primary"
            className="min-h-11"
            onClick={handleDone}
            data-testid="dingtalk-import-done"
          >
            {t('document.upload.dingtalk.done')}
          </Button>
        ) : (
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
        ),
        result === null && (
          <span
            className="text-xs text-text-secondary"
            aria-live="polite"
            data-testid="dingtalk-import-selected-count"
          >
            {t('document.upload.dingtalk.selectedCount', { count: expandedIds.length })}
          </span>
        )
      )}
    </>
  )
}
