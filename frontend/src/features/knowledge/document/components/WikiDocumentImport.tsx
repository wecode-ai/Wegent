// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * "External Wiki" tab of the add-material dialog for synchronized documents.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react'

import { getWikiConnectorPresentation } from './ExternalDocumentBadge'
import { getWikiDirectoryKeys, WikiPageTree } from './WikiPageTree'

import {
  wikiApis,
  type WikiBranchSummary,
  type WikiBoundDocument,
  type WikiConnectionSummary,
  type WikiPageSummary,
  type WikiProjectSummary,
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
  projectPath?: string
  branch?: string
}

interface WikiDocumentImportProps {
  knowledgeBaseId: number
  onImport: (pageIds: string[], options: WikiImportOptions) => Promise<WikiBindImportSummary>
  onDone?: () => void
  onDraftChange: (hasDraft: boolean) => void
  renderFooter: (action: React.ReactNode, status?: React.ReactNode) => React.ReactNode
  canManageDocuments?: boolean
}

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u
const SEARCH_TOKEN_PATTERN = /\p{Script=Han}+|[\p{L}\p{N}]+/gu
const WIKI_API_PAGE_SIZE = 200
const DEFAULT_PICKER_PAGE_SIZE = 20
const WIKIJS_CAPABILITIES = {
  resource_kind: 'page' as const,
  supports_locale: true,
  supports_project_selection: false,
  supports_branch_selection: false,
  supports_scheduled_sync: true,
}
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
  const [projects, setProjects] = useState<WikiProjectSummary[]>([])
  const [projectPath, setProjectPath] = useState('')
  const [branches, setBranches] = useState<WikiBranchSummary[]>([])
  const [branch, setBranch] = useState('')
  const [scopeLoading, setScopeLoading] = useState(false)
  const [bound, setBound] = useState<WikiBoundDocument[]>([])
  const [boundLoading, setBoundLoading] = useState(true)
  const [pages, setPages] = useState<WikiPageSummary[] | null>(null)
  const [pageWarnings, setPageWarnings] = useState<string[]>([])
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
  const connectionIdRef = useRef('')
  const projectPathRef = useRef('')
  const branchRef = useRef('')
  const projectsRequestIdRef = useRef(0)
  const branchesRequestIdRef = useRef(0)
  const pagesRequestIdRef = useRef(0)
  const selectedConnection = useMemo(
    () => connections.find(item => item.id === connectionId),
    [connectionId, connections]
  )
  const capabilities = selectedConnection
    ? selectedConnection.capabilities || WIKIJS_CAPABILITIES
    : undefined
  const isRepository = capabilities?.resource_kind === 'file'
  const isFlatProjectWiki =
    capabilities?.supports_project_selection && capabilities.resource_kind === 'page'
  const selectedConnector = getWikiConnectorPresentation(selectedConnection?.connector_type)
  const SelectedConnectorIcon = selectedConnector.Icon

  const resetConnectionScope = useCallback((nextConnectionId: string, nextSiteUrl: string) => {
    connectionIdRef.current = nextConnectionId
    projectPathRef.current = ''
    branchRef.current = ''
    projectsRequestIdRef.current += 1
    branchesRequestIdRef.current += 1
    pagesRequestIdRef.current += 1
    setConnectionId(nextConnectionId)
    setSiteUrl(nextSiteUrl)
    setConnectionError(null)
    setProjects([])
    setProjectPath('')
    setBranches([])
    setBranch('')
    setPages(null)
    setPageWarnings([])
    setSelected(new Set())
    setExpandedDirectories(new Set())
    setPickerPage(1)
    setScopeLoading(false)
    setPagesLoading(false)
  }, [])

  const resetProjectScope = useCallback((nextProjectPath: string) => {
    projectPathRef.current = nextProjectPath
    branchRef.current = ''
    branchesRequestIdRef.current += 1
    pagesRequestIdRef.current += 1
    setProjectPath(nextProjectPath)
    setBranches([])
    setBranch('')
    setPages(null)
    setPageWarnings([])
    setSelected(new Set())
    setExpandedDirectories(new Set())
    setPickerPage(1)
    setConnectionError(null)
    setPagesLoading(false)
  }, [])

  const resetBranchScope = useCallback((nextBranch: string) => {
    branchRef.current = nextBranch
    pagesRequestIdRef.current += 1
    setBranch(nextBranch)
    setPages(null)
    setPageWarnings([])
    setSelected(new Set())
    setExpandedDirectories(new Set())
    setPickerPage(1)
    setConnectionError(null)
    setPagesLoading(false)
  }, [])

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
        resetConnectionScope(available[0]?.id || '', available[0]?.site_url || '')
        setConnected(available.length > 0)
      } catch {
        setConnections([])
        resetConnectionScope('', '')
        setConnected(false)
      }
    }
    load()
    void loadBoundRef.current()
  }, [knowledgeBaseId, resetConnectionScope])

  const loadPages = useCallback(
    async (
      refresh = false,
      directoryPath = '',
      targetProject = '',
      targetBranch = '',
      targetConnectionId = connectionIdRef.current
    ) => {
      if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return
      if (capabilities?.supports_project_selection && !targetProject) return
      if (capabilities?.supports_branch_selection && !targetBranch) return
      if (capabilities?.supports_project_selection && targetProject !== projectPathRef.current) {
        return
      }
      if (capabilities?.supports_branch_selection && targetBranch !== branchRef.current) return
      const requestId = pagesRequestIdRef.current + 1
      pagesRequestIdRef.current = requestId
      const isCurrentRequest = () =>
        requestId === pagesRequestIdRef.current &&
        targetConnectionId === connectionIdRef.current &&
        (!capabilities?.supports_project_selection || targetProject === projectPathRef.current) &&
        (!capabilities?.supports_branch_selection || targetBranch === branchRef.current)
      try {
        setPagesLoading(true)
        const loadedPages: WikiPageSummary[] = []
        const loadedWarnings = new Set<string>()
        const visitedOffsets = new Set<number>()
        let offset = 0
        let firstRequest = true
        while (!visitedOffsets.has(offset)) {
          visitedOffsets.add(offset)
          const response = await wikiApis.listPages({
            limit: WIKI_API_PAGE_SIZE,
            connection_id: targetConnectionId,
            project_path: targetProject || undefined,
            branch: targetBranch || undefined,
            path: directoryPath || undefined,
            ...(offset ? { offset } : {}),
            ...(refresh && firstRequest ? { refresh: true } : {}),
          })
          if (!isCurrentRequest()) return
          loadedPages.push(...response.pages)
          response.warnings.forEach(warning => loadedWarnings.add(warning))
          firstRequest = false
          if (response.next_offset === null) break
          offset = response.next_offset
        }
        if (!isCurrentRequest()) return
        const uniquePages = [...new Map(loadedPages.map(page => [page.id, page])).values()]
        setPages(current => {
          if (!directoryPath) return uniquePages
          return [
            ...new Map([...(current || []), ...uniquePages].map(page => [page.id, page])).values(),
          ]
        })
        setPageWarnings([...loadedWarnings])
        if (!isRepository) setExpandedDirectories(getWikiDirectoryKeys(uniquePages))
        setPickerPage(1)
        setConnectionError(null)
        const availablePageIds = new Set(uniquePages.map(page => page.id))
        setSelected(current => {
          const next = new Set([...current].filter(pageId => availablePageIds.has(pageId)))
          return next.size === current.size ? current : next
        })
      } catch (error) {
        if (!isCurrentRequest()) return
        const message = (error as Error)?.message || t('wikiSection.load_tree_failed')
        setConnectionError(message)
        toast({
          variant: 'destructive',
          title: message,
        })
        setPages([])
        setPageWarnings([])
      } finally {
        if (isCurrentRequest()) setPagesLoading(false)
      }
    },
    [capabilities, isRepository, toast, t]
  )

  const loadProjects = useCallback(
    async (targetConnectionId: string) => {
      if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return
      const requestId = projectsRequestIdRef.current + 1
      projectsRequestIdRef.current = requestId
      const isCurrentRequest = () =>
        requestId === projectsRequestIdRef.current && targetConnectionId === connectionIdRef.current
      try {
        setScopeLoading(true)
        const loaded: WikiProjectSummary[] = []
        let offset = 0
        const visited = new Set<number>()
        while (!visited.has(offset)) {
          visited.add(offset)
          const response = await wikiApis.listProjects({
            connection_id: targetConnectionId,
            limit: WIKI_API_PAGE_SIZE,
            ...(offset ? { offset } : {}),
          })
          if (!isCurrentRequest()) return
          loaded.push(...response.projects)
          if (response.next_offset === null) break
          offset = response.next_offset
        }
        if (!isCurrentRequest()) return
        setProjects(loaded)
        resetProjectScope(loaded[0]?.path || '')
        if (!loaded.length) setPages([])
      } catch (error) {
        if (!isCurrentRequest()) return
        setProjects([])
        resetProjectScope('')
        setPages([])
        toast({
          variant: 'destructive',
          title: (error as Error)?.message || t('wikiSection.load_projects_failed'),
        })
      } finally {
        if (isCurrentRequest()) setScopeLoading(false)
      }
    },
    [resetProjectScope, t, toast]
  )

  const loadBranches = useCallback(
    async (targetConnectionId: string, targetProject: string, projectDefault: string | null) => {
      if (
        !targetConnectionId ||
        targetConnectionId !== connectionIdRef.current ||
        !targetProject ||
        targetProject !== projectPathRef.current
      ) {
        return
      }
      const requestId = branchesRequestIdRef.current + 1
      branchesRequestIdRef.current = requestId
      const isCurrentRequest = () =>
        requestId === branchesRequestIdRef.current &&
        targetConnectionId === connectionIdRef.current &&
        targetProject === projectPathRef.current
      try {
        setScopeLoading(true)
        const loaded: WikiBranchSummary[] = []
        let offset = 0
        const visited = new Set<number>()
        while (!visited.has(offset)) {
          visited.add(offset)
          const response = await wikiApis.listBranches({
            connection_id: targetConnectionId,
            project_path: targetProject,
            limit: WIKI_API_PAGE_SIZE,
            ...(offset ? { offset } : {}),
          })
          if (!isCurrentRequest()) return
          loaded.push(...response.branches)
          if (response.next_offset === null) break
          offset = response.next_offset
        }
        if (!isCurrentRequest()) return
        setBranches(loaded)
        resetBranchScope(
          loaded.find(item => item.name === projectDefault)?.name ||
            loaded.find(item => item.is_default)?.name ||
            loaded[0]?.name ||
            ''
        )
        if (!loaded.length) setPages([])
      } catch (error) {
        if (!isCurrentRequest()) return
        setBranches([])
        resetBranchScope('')
        setPages([])
        toast({
          variant: 'destructive',
          title: (error as Error)?.message || t('wikiSection.load_branches_failed'),
        })
      } finally {
        if (isCurrentRequest()) setScopeLoading(false)
      }
    },
    [resetBranchScope, t, toast]
  )

  useEffect(() => {
    if (!connected || !connectionId || !capabilities) return
    if (capabilities.supports_project_selection) void loadProjects(connectionId)
    else void loadPages(false, '', '', '', connectionId)
  }, [capabilities, connected, connectionId, loadPages, loadProjects])

  useEffect(() => {
    if (!projectPath || !capabilities?.supports_project_selection) return
    const project = projects.find(item => item.path === projectPath)
    if (!project) return
    if (capabilities.supports_branch_selection) {
      void loadBranches(connectionId, projectPath, project.default_branch)
    } else {
      void loadPages(false, '', projectPath, '', connectionId)
    }
  }, [capabilities, connectionId, loadBranches, loadPages, projectPath, projects])

  useEffect(() => {
    if (!branch || !capabilities?.supports_branch_selection) return
    if (!branches.some(item => item.name === branch)) return
    void loadPages(false, '', projectPath, branch, connectionId)
  }, [branch, branches, capabilities, connectionId, loadPages, projectPath])

  useEffect(() => {
    onDraftChange(selected.size > 0)
  }, [selected, onDraftChange])

  const boundPageIds = useMemo(
    () =>
      new Set(
        bound
          .filter(
            item =>
              item.connection_id === connectionId &&
              (!capabilities?.supports_project_selection || item.project_path === projectPath) &&
              (!capabilities?.supports_branch_selection || item.branch === branch)
          )
          .map(item => item.page_id)
      ),
    [bound, branch, capabilities, connectionId, projectPath]
  )

  const filteredPages = useMemo(() => {
    if (!pages) return []
    return pages
      .filter(page => matchesWikiSearch(page.title, page.path, keyword))
      .sort(compareWikiPagesByPath)
  }, [pages, keyword])

  const pickerTotalPages = isRepository
    ? 1
    : Math.max(1, Math.ceil(filteredPages.length / pickerPageSize))
  const effectivePickerPage = Math.min(pickerPage, pickerTotalPages)
  const visiblePages = useMemo(() => {
    if (isRepository) return filteredPages
    const start = (effectivePickerPage - 1) * pickerPageSize
    return filteredPages.slice(start, start + pickerPageSize)
  }, [effectivePickerPage, filteredPages, isRepository, pickerPageSize])

  useEffect(() => {
    setPickerPage(1)
  }, [keyword, pickerPageSize])

  useEffect(() => {
    if (pickerPage > pickerTotalPages) setPickerPage(pickerTotalPages)
  }, [pickerPage, pickerTotalPages])

  const filteredBound = useMemo(() => {
    return bound.filter(item => matchesWikiSearch(item.name, item.path, boundKeyword))
  }, [bound, boundKeyword])

  const updateSelection = (pageIds: readonly string[]) => {
    setSelected(current => {
      const next = new Set(current)
      const select = !pageIds.every(pageId => current.has(pageId))
      for (const pageId of pageIds) {
        if (select) next.add(pageId)
        else next.delete(pageId)
      }
      return next
    })
  }

  const selectableFilteredPageIds = filteredPages
    .filter(page => page.importable !== false && !page.is_directory && !boundPageIds.has(page.id))
    .map(page => page.id)
  const allFilteredSelected =
    selectableFilteredPageIds.length > 0 &&
    selectableFilteredPageIds.every(pageId => selected.has(pageId))
  const selectionToggleKey = allFilteredSelected
    ? 'wikiSection.clear_selection'
    : 'wikiSection.select_all'
  const selectionToggleLabel = t(selectionToggleKey)

  const toggleDirectory = (path: string) => {
    setExpandedDirectories(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleImport = async () => {
    const pageIds = [...selected]
    if (!pageIds.length) return
    try {
      setSubmitting(true)
      const summary = await onImport(pageIds, {
        connectionId,
        projectPath: projectPath || undefined,
        branch: branch || undefined,
      })
      setSelected(new Set())
      await loadBound()
      onDone?.()
      const notifications = [
        [summary.createdCount, 'wikiSection.bind_scope_success_n'],
        [summary.duplicateCount, 'wikiSection.already_bound_n'],
        [summary.updatedCount, 'wikiSection.resynced_n'],
        [summary.processingCount, 'wikiSection.processing_n'],
      ] as const
      for (const [count, key] of notifications) {
        if (count > 0) toast({ title: t(key, { count }) })
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
              onChange={event => {
                const nextConnectionId = event.target.value
                const connection = connections.find(item => item.id === nextConnectionId)
                resetConnectionScope(nextConnectionId, connection?.site_url || '')
              }}
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
        {capabilities?.supports_project_selection && (
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <span>{t('wikiSection.project')}</span>
            <select
              value={projectPath}
              onChange={event => resetProjectScope(event.target.value)}
              disabled={scopeLoading || projects.length === 0}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3"
              data-testid="wiki-import-project-select"
            >
              {projects.length === 0 && <option value="">{t('wikiSection.no_projects')}</option>}
              {projects.map(project => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {capabilities?.supports_branch_selection && (
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <span>{t('wikiSection.branch')}</span>
            <select
              value={branch}
              onChange={event => resetBranchScope(event.target.value)}
              disabled={scopeLoading || branches.length === 0}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3"
              data-testid="wiki-import-branch-select"
            >
              {branches.length === 0 && <option value="">{t('wikiSection.no_branches')}</option>}
              {branches.map(item => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <SelectedConnectorIcon
            aria-label={selectedConnector.label}
            className="h-3.5 w-3.5 shrink-0"
            data-connector-type={selectedConnector.type.replace('_', '-')}
            data-testid="wiki-import-connector-icon"
          />
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
                {t('wikiSection.item_count', { count: filteredBound.length })}
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
              {filteredBound.map(item => {
                const connector = getWikiConnectorPresentation(item.adapter_type)
                const ConnectorIcon = connector.Icon
                return (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded border border-border/70 bg-surface px-2 py-1.5"
                    data-testid={`wiki-import-bound-${item.id}`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      <ConnectorIcon
                        aria-label={connector.label}
                        className="h-3.5 w-3.5 shrink-0 text-text-muted"
                        data-connector-type={connector.type.replace('_', '-')}
                        data-testid={`wiki-import-bound-connector-${item.id}`}
                      />
                      <span className="truncate">{item.name}</span>
                      <span
                        className="shrink-0 text-xs text-text-muted"
                        data-testid={`wiki-import-bound-connector-name-${item.id}`}
                      >
                        {connector.label}
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
                )
              })}
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
                {t('wikiSection.item_count', { count: filteredPages.length })}
              </span>
            </h4>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="min-h-11 shrink-0 px-3 md:min-h-8"
              onClick={() => void loadPages(true, '', projectPath, branch, connectionId)}
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
              onClick={() => updateSelection(selectableFilteredPageIds)}
              disabled={
                pagesLoading || selectableFilteredPageIds.length === 0 || !canManageDocuments
              }
              data-testid="wiki-import-select-all"
            >
              {selectionToggleLabel}
            </Button>
          </div>
          {pageWarnings.map(warning => (
            <div
              key={warning}
              role="status"
              className="mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-primary"
              data-testid="wiki-import-page-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {warning === 'wiki_page_list_truncated'
                  ? t('wikiSection.page_list_truncated')
                  : warning}
              </span>
            </div>
          ))}
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
                {isFlatProjectWiki ? (
                  <ul className="space-y-1" data-testid="wiki-import-page-list">
                    {visiblePages.map(page => {
                      const isBound = boundPageIds.has(page.id)
                      return (
                        <li key={page.id}>
                          <label
                            className={`flex min-h-11 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface ${
                              isBound || page.importable === false
                                ? 'cursor-not-allowed opacity-50'
                                : ''
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(page.id)}
                              disabled={isBound || page.importable === false || !canManageDocuments}
                              onChange={() => updateSelection([page.id])}
                              data-testid={`wiki-import-check-${page.path}`}
                            />
                            <span className="min-w-0 flex-1 truncate">{page.title}</span>
                            <span className="max-w-[45%] truncate text-xs text-text-muted">
                              {page.path}
                            </span>
                            {isBound && (
                              <span className="text-xs text-text-muted">
                                {t('wikiSection.already_bound')}
                              </span>
                            )}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <WikiPageTree
                    pages={visiblePages}
                    boundPageIds={boundPageIds}
                    selectedPageIds={selected}
                    selectablePages={filteredPages.filter(
                      page =>
                        page.importable !== false &&
                        !page.is_directory &&
                        !boundPageIds.has(page.id)
                    )}
                    expandedPaths={expandedDirectories}
                    disabled={!canManageDocuments}
                    forceExpanded={Boolean(keyword.trim())}
                    onTogglePage={pageId => updateSelection([pageId])}
                    onToggleDirectory={toggleDirectory}
                    onLoadDirectory={path => {
                      const hasLoadedChildren = pages?.some(
                        page => page.path !== path && page.path.startsWith(`${path}/`)
                      )
                      if (!hasLoadedChildren) {
                        void loadPages(false, path, projectPath, branch, connectionId)
                      }
                    }}
                    onToggleDirectorySelection={updateSelection}
                  />
                )}
              </div>
              {!isRepository && (
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
              )}
            </>
          )}
        </section>
      </div>
      {renderFooter(action)}
    </>
  )
}
