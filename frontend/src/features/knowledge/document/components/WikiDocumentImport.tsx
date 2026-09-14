// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * "External Wiki" tab of the add-material dialog for synchronized documents.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink as BookExternalLink, Link2, Loader2, RefreshCw, X } from 'lucide-react'

import { getWikiDirectoryKeys, WikiPageTree } from './WikiPageTree'

import {
  wikiApis,
  type WikiBoundDocument,
  type WikiConnectionSummary,
  type WikiPageSummary,
} from '@/apis/wiki'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Tag } from '@/components/ui/tag'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export interface WikiBindImportSummary {
  createdCount: number
  updatedCount: number
  processingCount: number
  duplicateCount: number
}

export interface WikiImportOptions {
  connectionId: string
}

interface WikiDocumentImportProps {
  knowledgeBaseId: number
  onImport: (paths: string[], options: WikiImportOptions) => Promise<WikiBindImportSummary>
  onDone?: () => void
  onDraftChange: (hasDraft: boolean) => void
  renderFooter: (action: React.ReactNode, status?: React.ReactNode) => React.ReactNode
  canManageDocuments?: boolean
}

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u
const SEARCH_TOKEN_PATTERN = /\p{Script=Han}+|[\p{L}\p{N}]+/gu
const WIKI_API_PAGE_SIZE = 200
const DEFAULT_PICKER_PAGE_SIZE = 20
const WIKI_PATH_COLLATOR = new Intl.Collator(['zh-CN', 'en'], {
  numeric: true,
  sensitivity: 'base',
})

function compareWikiPagesByPath(left: WikiPageSummary, right: WikiPageSummary): number {
  return (
    WIKI_PATH_COLLATOR.compare(left.path, right.path) ||
    WIKI_PATH_COLLATOR.compare(left.title, right.title) ||
    WIKI_PATH_COLLATOR.compare(String(left.id), String(right.id))
  )
}

function matchesWikiSearch(title: string, path: string, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true

  const searchable = `${title} ${path}`.toLowerCase()
  const queryTokens = query.match(SEARCH_TOKEN_PATTERN)
  if (!queryTokens?.length) return searchable.includes(query)

  const wordTokens = searchable.match(/[\p{L}\p{N}]+/gu) || []
  return queryTokens.every(token =>
    HAN_CHARACTER_PATTERN.test(token)
      ? searchable.includes(token)
      : wordTokens.some(word => word.startsWith(token))
  )
}

export function WikiDocumentImport({
  knowledgeBaseId,
  onImport,
  onDone,
  onDraftChange,
  renderFooter,
  canManageDocuments = true,
}: WikiDocumentImportProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [siteUrl, setSiteUrl] = useState('')
  const [connections, setConnections] = useState<WikiConnectionSummary[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [bound, setBound] = useState<WikiBoundDocument[]>([])
  const [boundLoading, setBoundLoading] = useState(true)
  const [pages, setPages] = useState<WikiPageSummary[] | null>(null)
  const [pagesLoading, setPagesLoading] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [boundKeyword, setBoundKeyword] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set())
  const [pickerPage, setPickerPage] = useState(1)
  const [pickerPageSize, setPickerPageSize] = useState(DEFAULT_PICKER_PAGE_SIZE)
  const [submitting, setSubmitting] = useState(false)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const pagesRequestIdRef = useRef(0)

  const loadBound = useCallback(async () => {
    try {
      setBoundLoading(true)
      setBound(await wikiApis.listKbWikiDocuments(knowledgeBaseId))
    } catch {
      toast({ variant: 'destructive', title: t('wikiSection.load_failed') })
    } finally {
      setBoundLoading(false)
    }
  }, [knowledgeBaseId, toast, t])
  const loadBoundRef = useRef(loadBound)
  loadBoundRef.current = loadBound

  useEffect(() => {
    const load = async () => {
      try {
        const response = await wikiApis.listConnections()
        const available = response.connections.filter(item => item.enabled && item.site_url)
        setConnections(available)
        setConnectionId(available[0]?.id || '')
        setSiteUrl(available[0]?.site_url || '')
        setConnected(available.length > 0)
      } catch {
        setConnected(false)
      }
    }
    load()
    void loadBoundRef.current()
  }, [knowledgeBaseId])

  const loadPages = useCallback(
    async (refresh = false) => {
      const requestId = pagesRequestIdRef.current + 1
      pagesRequestIdRef.current = requestId
      try {
        setPagesLoading(true)
        const loadedPages: WikiPageSummary[] = []
        const visitedOffsets = new Set<number>()
        let offset = 0
        let firstRequest = true
        while (!visitedOffsets.has(offset)) {
          visitedOffsets.add(offset)
          const response = await wikiApis.listPages({
            limit: WIKI_API_PAGE_SIZE,
            connection_id: connectionId || undefined,
            ...(offset ? { offset } : {}),
            ...(refresh && firstRequest ? { refresh: true } : {}),
          })
          loadedPages.push(...response.pages)
          firstRequest = false
          if (response.next_offset === null) break
          offset = response.next_offset
        }
        if (requestId !== pagesRequestIdRef.current) return
        const uniquePages = [...new Map(loadedPages.map(page => [page.path, page])).values()]
        setPages(uniquePages)
        setExpandedDirectories(getWikiDirectoryKeys(uniquePages))
        setPickerPage(1)
        setConnectionError(null)
        const availablePaths = new Set(uniquePages.map(page => page.path))
        setSelected(current => {
          const next = new Set([...current].filter(path => availablePaths.has(path)))
          return next.size === current.size ? current : next
        })
      } catch (error) {
        if (requestId !== pagesRequestIdRef.current) return
        const message = (error as Error)?.message || t('wikiSection.load_tree_failed')
        setConnectionError(message)
        toast({
          variant: 'destructive',
          title: message,
        })
        setPages([])
      } finally {
        if (requestId === pagesRequestIdRef.current) setPagesLoading(false)
      }
    },
    [connectionId, toast, t]
  )

  useEffect(() => {
    if (connected && connectionId) void loadPages()
  }, [connected, connectionId, loadPages])

  useEffect(() => {
    const connection = connections.find(item => item.id === connectionId)
    setSiteUrl(connection?.site_url || '')
    setConnectionError(null)
    setPages(null)
    setSelected(new Set())
    setExpandedDirectories(new Set())
    setPickerPage(1)
  }, [connectionId, connections])

  useEffect(() => {
    onDraftChange(selected.size > 0)
  }, [selected, onDraftChange])

  const boundPaths = useMemo(
    () => new Set(bound.filter(item => item.connection_id === connectionId).map(item => item.path)),
    [bound, connectionId]
  )

  const filteredPages = useMemo(() => {
    if (!pages) return []
    return pages
      .filter(page => matchesWikiSearch(page.title, page.path, keyword))
      .sort(compareWikiPagesByPath)
  }, [pages, keyword])

  const pickerTotalPages = Math.max(1, Math.ceil(filteredPages.length / pickerPageSize))
  const effectivePickerPage = Math.min(pickerPage, pickerTotalPages)
  const visiblePages = useMemo(() => {
    const start = (effectivePickerPage - 1) * pickerPageSize
    return filteredPages.slice(start, start + pickerPageSize)
  }, [effectivePickerPage, filteredPages, pickerPageSize])

  useEffect(() => {
    setPickerPage(1)
  }, [keyword, pickerPageSize])

  useEffect(() => {
    if (pickerPage > pickerTotalPages) setPickerPage(pickerTotalPages)
  }, [pickerPage, pickerTotalPages])

  const filteredBound = useMemo(() => {
    return bound.filter(item => matchesWikiSearch(item.name, item.path, boundKeyword))
  }, [bound, boundKeyword])

  const toggle = (path: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectableFilteredPaths = filteredPages
    .filter(page => !boundPaths.has(page.path))
    .map(page => page.path)
  const allFilteredSelected =
    selectableFilteredPaths.length > 0 && selectableFilteredPaths.every(path => selected.has(path))
  const selectionToggleKey = allFilteredSelected
    ? 'wikiSection.clear_selection'
    : 'wikiSection.select_all'
  const selectionToggleTranslation = t(selectionToggleKey)
  // The i18n singleton can briefly retain the previous resource bundle during hot updates.
  const selectionToggleTranslationMissing =
    selectionToggleTranslation === selectionToggleKey ||
    selectionToggleTranslation === `knowledge:${selectionToggleKey}`
  const selectionToggleLabel = selectionToggleTranslationMissing
    ? t(
        allFilteredSelected
          ? 'document.upload.dingtalk.clearSelection'
          : 'document.upload.dingtalk.selectAll'
      )
    : selectionToggleTranslation

  const toggleAllFiltered = () => {
    setSelected(current => {
      const next = new Set(current)
      for (const path of selectableFilteredPaths) {
        if (allFilteredSelected) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }

  const toggleDirectory = (path: string) => {
    setExpandedDirectories(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleDirectorySelection = (paths: string[]) => {
    setSelected(current => {
      const next = new Set(current)
      const shouldClear = paths.every(path => current.has(path))
      for (const path of paths) {
        if (shouldClear) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }

  const handleImport = async () => {
    const paths = [...selected]
    if (!paths.length) return
    try {
      setSubmitting(true)
      const summary = await onImport(paths, { connectionId })
      setSelected(new Set())
      await loadBound()
      onDone?.()
      if (summary.createdCount > 0) {
        toast({
          title: t('wikiSection.bind_scope_success_n', {
            count: summary.createdCount,
          }),
        })
      }
      if (summary.duplicateCount > 0) {
        toast({
          title: t('wikiSection.already_bound_n', {
            count: summary.duplicateCount,
          }),
        })
      }
      if (summary.updatedCount > 0) {
        toast({
          title: t('wikiSection.resynced_n', {
            count: summary.updatedCount,
          }),
        })
      }
      if (summary.processingCount > 0) {
        toast({
          title: t('wikiSection.processing_n', {
            count: summary.processingCount,
          }),
        })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('wikiSection.add_failed'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleUnbind = async (documentId: number) => {
    try {
      setRemovingId(documentId)
      await wikiApis.unbindKbWikiDocument(knowledgeBaseId, documentId)
      await loadBound()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('wikiSection.remove_failed'),
      })
    } finally {
      setRemovingId(null)
    }
  }

  if (connected === false) {
    return renderFooter(
      <Button
        variant="primary"
        className="min-h-11"
        disabled
        data-testid="wiki-import-need-connection"
      >
        {t('wikiSection.need_connection')}
      </Button>
    )
  }

  const action = (
    <Button
      variant="primary"
      className="min-h-11"
      onClick={() => void handleImport()}
      disabled={submitting || selected.size === 0 || !canManageDocuments || boundLoading}
      data-testid="wiki-import-submit-button"
    >
      {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {t('wikiSection.bind_selected', { count: selected.size })}
    </Button>
  )

  const connectionStatus = pagesLoading
    ? 'checking'
    : connectionError
      ? 'failed'
      : pages
        ? 'connected'
        : 'checking'

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        data-testid="wiki-import-content"
      >
        {connections.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <span>{t('wikiSection.connection')}</span>
            <select
              value={connectionId}
              onChange={event => setConnectionId(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3"
              data-testid="wiki-import-connection-select"
            >
              {connections.map(connection => (
                <option key={connection.id} value={connection.id}>
                  {connection.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <BookExternalLink className="h-3.5 w-3.5" />
          <span className="min-w-0 truncate" data-testid="wiki-import-site">
            {siteUrl}
          </span>
          <Tag
            variant={
              connectionStatus === 'connected'
                ? 'success'
                : connectionStatus === 'failed'
                  ? 'error'
                  : 'default'
            }
            title={
              connectionStatus === 'failed'
                ? t('wikiSection.connection_failed_tooltip', {
                    message: connectionError || t('wikiSection.load_tree_failed'),
                  })
                : undefined
            }
            data-status={connectionStatus}
            data-testid="wiki-import-connection-status"
          >
            {t('wikiSection.synced_badge')}
          </Tag>
        </div>

        <section className="shrink-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h4 className="mr-auto text-xs font-medium text-text-primary">
              {t('wikiSection.bound_title')}
              <span className="ml-1 text-text-muted" data-testid="wiki-import-bound-count">
                （{filteredBound.length}）
              </span>
            </h4>
            <Input
              value={boundKeyword}
              onChange={event => setBoundKeyword(event.target.value)}
              placeholder={t('wikiSection.picker_search')}
              disabled={boundLoading || bound.length === 0}
              className="min-h-11 w-full text-xs sm:w-48 md:h-7 md:min-h-7"
              data-testid="wiki-import-bound-search-input"
            />
          </div>
          {boundLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('wikiSection.loading')}
            </div>
          ) : bound.length === 0 ? (
            <p className="py-1 text-xs text-text-muted">{t('wikiSection.bound_empty')}</p>
          ) : filteredBound.length === 0 ? (
            <p className="h-24 py-2 text-xs text-text-muted">{t('document.document.noResults')}</p>
          ) : (
            <ul
              className="h-24 shrink-0 space-y-1 overflow-y-auto pr-1"
              data-testid="wiki-import-bound-list"
            >
              {filteredBound.map(item => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded border border-border/70 bg-surface px-2 py-1.5"
                  data-testid={`wiki-import-bound-${item.id}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-sm">
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {t('wikiSection.synced_badge')}
                    </span>
                  </span>
                  {canManageDocuments && (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      className="min-h-11 min-w-11 px-1.5 md:h-6 md:min-h-6 md:min-w-0"
                      onClick={() => void handleUnbind(item.id)}
                      disabled={removingId === item.id}
                      aria-label={t('wikiSection.unbind')}
                      data-testid={`wiki-import-unbind-${item.id}`}
                    >
                      {removingId === item.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <X className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="flex min-h-48 flex-1 shrink-0 flex-col"
          data-testid="wiki-import-page-picker"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h4 className="mr-auto text-xs font-medium text-text-primary">
              {t('wikiSection.picker_title')}
              <span className="ml-1 text-text-muted" data-testid="wiki-import-page-count">
                （{filteredPages.length}）
              </span>
            </h4>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="min-h-11 shrink-0 px-3 md:min-h-8"
              onClick={() => void loadPages(true)}
              disabled={pagesLoading || !connectionId}
              data-testid="wiki-import-refresh-button"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${pagesLoading ? 'animate-spin' : ''}`} />
              {t('common:actions.refresh')}
            </Button>
            <Input
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder={t('wikiSection.picker_search')}
              className="min-h-11 w-full text-xs sm:w-48 md:h-7 md:min-h-7"
              data-testid="wiki-import-search-input"
            />
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="min-h-11 shrink-0 px-3 text-xs text-primary md:min-h-8"
              onClick={toggleAllFiltered}
              disabled={pagesLoading || selectableFilteredPaths.length === 0 || !canManageDocuments}
              data-testid="wiki-import-select-all"
            >
              {selectionToggleLabel}
            </Button>
          </div>
          {pagesLoading || pages === null ? (
            <div className="flex items-center gap-2 py-3 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('wikiSection.loading')}
            </div>
          ) : filteredPages.length === 0 ? (
            <p className="py-2 text-xs text-text-muted">{t('wikiSection.tree_empty')}</p>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <WikiPageTree
                  pages={visiblePages}
                  boundPaths={boundPaths}
                  selectedPaths={selected}
                  selectablePaths={selectableFilteredPaths}
                  expandedPaths={expandedDirectories}
                  disabled={!canManageDocuments}
                  forceExpanded={Boolean(keyword.trim())}
                  onTogglePage={toggle}
                  onToggleDirectory={toggleDirectory}
                  onToggleDirectorySelection={toggleDirectorySelection}
                />
              </div>
              <div className="shrink-0" data-testid="wiki-import-pagination">
                <Pagination
                  page={effectivePickerPage}
                  totalPages={pickerTotalPages}
                  totalCount={filteredPages.length}
                  pageSize={pickerPageSize}
                  pageSizeOptions={[20, 50, 100]}
                  onGoToPage={setPickerPage}
                  onPageSizeChange={setPickerPageSize}
                  disabled={pagesLoading}
                />
              </div>
            </>
          )}
        </section>
      </div>
      {renderFooter(action)}
    </>
  )
}
