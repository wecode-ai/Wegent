// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react'

import {
  adminPluginPublicationApis,
  type AdminPluginPublicationRequestDetail,
  type AdminPluginPublicationRequestSummary,
  type PluginPublicationRiskLevel,
  type PluginPublicationStatus,
} from '@/apis/admin-plugin-publications'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { formatUTC8DateTime } from '@/lib/utils'
import PluginPublicationReviewDrawer from './PluginPublicationReviewDrawer'
import { PluginPublicationRiskTag, PluginPublicationStatusTag } from './PluginPublicationStatus'

const PAGE_SIZE = 20
const FILTER_DEBOUNCE_MS = 300
const DEFAULT_STATUS: PluginPublicationStatus = 'awaiting_admin'

const STATUS_FILTERS: Array<PluginPublicationStatus | 'all'> = [
  'awaiting_admin',
  'admin_review',
  'all',
  'changes_requested',
  'admin_accepted',
  'draft_mr_open',
  'ci_running',
  'published',
  'automatic_check_failed',
  'publish_failed',
  'withdrawn',
]

const RISK_FILTERS: Array<PluginPublicationRiskLevel | 'all'> = [
  'all',
  'critical',
  'high',
  'medium',
  'low',
  'none',
]

interface QueueUrlState {
  page: number
  status: PluginPublicationStatus | 'all'
  risk: PluginPublicationRiskLevel | 'all'
  search: string
  submitter: string
  submittedAfter: string
  submittedBefore: string
  requestId: number | null
}

function parseRequestId(value: string | null): number | null {
  if (!value) return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function parsePage(value: string | null): number {
  if (!value) return 1
  const page = Number(value)
  return Number.isInteger(page) && page > 0 ? page : 1
}

function parseStatus(value: string | null): PluginPublicationStatus | 'all' {
  return STATUS_FILTERS.includes(value as PluginPublicationStatus | 'all')
    ? (value as PluginPublicationStatus | 'all')
    : DEFAULT_STATUS
}

function parseRisk(value: string | null): PluginPublicationRiskLevel | 'all' {
  return RISK_FILTERS.includes(value as PluginPublicationRiskLevel | 'all')
    ? (value as PluginPublicationRiskLevel | 'all')
    : 'all'
}

function parseDate(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

function parseQueueUrlState(params: URLSearchParams): QueueUrlState {
  return {
    page: parsePage(params.get('page')),
    status: parseStatus(params.get('status')),
    risk: parseRisk(params.get('risk')),
    search: params.get('query')?.trim() ?? '',
    submitter: params.get('submitter')?.trim() ?? '',
    submittedAfter: parseDate(params.get('submittedAfter')),
    submittedBefore: parseDate(params.get('submittedBefore')),
    requestId: parseRequestId(params.get('request')),
  }
}

function waitingDuration(
  item: AdminPluginPublicationRequestSummary,
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  const elapsedHours =
    item.waitingDurationSeconds === undefined
      ? Math.max(0, (Date.now() - new Date(item.submittedAt).getTime()) / 3_600_000)
      : Math.max(0, item.waitingDurationSeconds / 3600)
  if (!Number.isFinite(elapsedHours)) return '-'
  if (elapsedHours < 1) {
    return t('marketplace_management.plugin_publications.queue.waiting_under_hour')
  }
  if (elapsedHours < 24) {
    return t('marketplace_management.plugin_publications.queue.waiting_hours', {
      count: Math.floor(elapsedHours),
    })
  }
  return t('marketplace_management.plugin_publications.queue.waiting_days', {
    count: Math.floor(elapsedHours / 24),
  })
}

function gitLabStatus(
  item: AdminPluginPublicationRequestSummary,
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  if (item.gitlabStatus) {
    const knownStatuses = new Set([
      'created',
      'opened',
      'running',
      'pending',
      'success',
      'failed',
      'canceled',
      'merged',
      'closed',
    ])
    return knownStatuses.has(item.gitlabStatus)
      ? t(`marketplace_management.plugin_publications.gitlab_statuses.${item.gitlabStatus}`)
      : item.gitlabStatus
  }
  return t('marketplace_management.plugin_publications.queue.gitlab_pending')
}

export default function PluginPublicationReviewQueue() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchParamsKey = searchParams.toString()
  const parsedSearchParamsRef = useRef(searchParamsKey)
  const latestParamsRef = useRef(searchParamsKey)
  const initialUrlState = useMemo(
    () => parseQueueUrlState(new URLSearchParams(searchParamsKey)),
    [searchParamsKey]
  )
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(
    initialUrlState.requestId
  )
  const [items, setItems] = useState<AdminPluginPublicationRequestSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(initialUrlState.page)
  const [statusFilter, setStatusFilter] = useState<PluginPublicationStatus | 'all'>(
    initialUrlState.status
  )
  const [riskFilter, setRiskFilter] = useState<PluginPublicationRiskLevel | 'all'>(
    initialUrlState.risk
  )
  const [search, setSearch] = useState(initialUrlState.search)
  const [submitter, setSubmitter] = useState(initialUrlState.submitter)
  const [appliedSearch, setAppliedSearch] = useState(initialUrlState.search)
  const [appliedSubmitter, setAppliedSubmitter] = useState(initialUrlState.submitter)
  const [submittedAfter, setSubmittedAfter] = useState(initialUrlState.submittedAfter)
  const [submittedBefore, setSubmittedBefore] = useState(initialUrlState.submittedBefore)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const replaceUrlParams = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(latestParamsRef.current)
      params.set('tab', 'wework-plugin-publications')
      params.delete('view')
      Object.entries(changes).forEach(([key, value]) => {
        if (value === null || value === '') params.delete(key)
        else params.set(key, value)
      })
      const nextParams = params.toString()
      latestParamsRef.current = nextParams
      router.replace(`?${nextParams}`, { scroll: false })
    },
    [router]
  )

  useEffect(() => {
    if (parsedSearchParamsRef.current === searchParamsKey) return
    parsedSearchParamsRef.current = searchParamsKey
    latestParamsRef.current = searchParamsKey
    const next = parseQueueUrlState(new URLSearchParams(searchParamsKey))
    setSelectedRequestId(next.requestId)
    setPage(next.page)
    setStatusFilter(next.status)
    setRiskFilter(next.risk)
    setSearch(next.search)
    setSubmitter(next.submitter)
    setAppliedSearch(next.search)
    setAppliedSubmitter(next.submitter)
    setSubmittedAfter(next.submittedAfter)
    setSubmittedBefore(next.submittedBefore)
  }, [searchParamsKey])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextSearch = search.trim()
      const nextSubmitter = submitter.trim()
      if (nextSearch === appliedSearch && nextSubmitter === appliedSubmitter) return
      setPage(1)
      setAppliedSearch(nextSearch)
      setAppliedSubmitter(nextSubmitter)
      replaceUrlParams({
        page: null,
        query: nextSearch || null,
        submitter: nextSubmitter || null,
      })
    }, FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [appliedSearch, appliedSubmitter, replaceUrlParams, search, submitter])

  const loadRequests = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setLoadFailed(false)
      try {
        const response = await adminPluginPublicationApis.listPublicationRequests(
          {
            page,
            limit: PAGE_SIZE,
            status: statusFilter,
            riskLevel: riskFilter,
            submitter: appliedSubmitter,
            query: appliedSearch,
            submittedAfter,
            submittedBefore,
          },
          signal
        )
        setItems(response.items)
        setTotal(response.total)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        setItems([])
        setTotal(0)
        setLoadFailed(true)
        toast({
          title: t('marketplace_management.plugin_publications.queue.load_failed'),
          variant: 'destructive',
        })
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [
      appliedSearch,
      appliedSubmitter,
      page,
      riskFilter,
      statusFilter,
      submittedAfter,
      submittedBefore,
      t,
      toast,
    ]
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadRequests(controller.signal)
    return () => controller.abort()
  }, [loadRequests, refreshVersion])

  const openRequest = useCallback(
    (requestId: number) => {
      setSelectedRequestId(requestId)
      replaceUrlParams({ request: String(requestId) })
    },
    [replaceUrlParams]
  )

  const closeRequest = useCallback(() => {
    setSelectedRequestId(null)
    replaceUrlParams({ request: null })
  }, [replaceUrlParams])

  const handleRequestUpdated = (updated: AdminPluginPublicationRequestDetail) => {
    setItems(previous => previous.map(item => (item.id === updated.id ? updated : item)))
    setRefreshVersion(current => current + 1)
  }

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage)
    replaceUrlParams({ page: nextPage === 1 ? null : String(nextPage) })
  }

  const stageLabel = useCallback(
    (item: AdminPluginPublicationRequestSummary) =>
      t(`marketplace_management.plugin_publications.stages.${item.stage}`),
    [t]
  )

  const queueContent = useMemo(() => {
    if (loading) {
      return (
        <div
          className="flex min-h-72 items-center justify-center"
          data-testid="plugin-publication-review-loading"
        >
          <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden />
        </div>
      )
    }

    if (loadFailed) {
      return (
        <div className="flex min-h-72 flex-col items-center justify-center gap-4 px-4 text-center">
          <AlertTriangle className="h-10 w-10 text-error" aria-hidden />
          <p className="text-sm text-text-muted">
            {t('marketplace_management.plugin_publications.queue.load_failed')}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRefreshVersion(current => current + 1)}
            data-testid="plugin-publication-review-retry"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('marketplace_management.plugin_publications.actions.retry')}
          </Button>
        </div>
      )
    }

    if (items.length === 0) {
      return (
        <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-4 text-center">
          <ClipboardCheck className="h-11 w-11 text-text-muted" aria-hidden />
          <p className="font-medium text-text-primary">
            {t('marketplace_management.plugin_publications.queue.empty')}
          </p>
          <p className="max-w-md text-sm text-text-muted">
            {t('marketplace_management.plugin_publications.queue.empty_description')}
          </p>
        </div>
      )
    }

    return (
      <div className="space-y-3" data-testid="plugin-publication-review-list">
        {items.map(item => (
          <Card
            key={item.id}
            role="button"
            tabIndex={0}
            className="group cursor-pointer p-4 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => openRequest(item.id)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openRequest(item.id)
              }
            }}
            aria-label={t('marketplace_management.plugin_publications.queue.open_request', {
              plugin: item.pluginName,
              revision: item.currentRevision,
            })}
            data-testid={`plugin-publication-review-row-${item.id}`}
          >
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate font-semibold text-text-primary">{item.pluginName}</h3>
                  <span className="text-sm text-text-muted">
                    v{item.requestedVersion} · Revision {item.currentRevision}
                  </span>
                  <PluginPublicationStatusTag status={item.status} />
                  <PluginPublicationRiskTag riskLevel={item.riskLevel} />
                </div>
                <p className="mt-1 truncate font-mono text-xs text-text-muted">{item.pluginSlug}</p>
                <div className="mt-3 grid gap-x-5 gap-y-2 text-xs text-text-muted sm:grid-cols-2 xl:grid-cols-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{item.submitter.userName}</span>
                  </span>
                  <span>
                    {t('marketplace_management.plugin_publications.queue.stage', {
                      stage: stageLabel(item),
                    })}
                  </span>
                  <span>
                    {t('marketplace_management.plugin_publications.queue.findings', {
                      blockers: item.blockerCount,
                      warnings: item.warningCount,
                    })}
                  </span>
                  <span>
                    {t('marketplace_management.plugin_publications.queue.submitted_at', {
                      time: formatUTC8DateTime(item.submittedAt),
                    })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t('marketplace_management.plugin_publications.queue.waiting', {
                      duration: waitingDuration(item, t),
                    })}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <GitMerge className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{gitLabStatus(item, t)}</span>
                  </span>
                </div>
              </div>
              <ChevronRight
                className="mt-1 h-5 w-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                aria-hidden
              />
            </div>
          </Card>
        ))}
      </div>
    )
  }, [items, loadFailed, loading, openRequest, stageLabel, t])

  return (
    <div className="space-y-5" data-testid="plugin-publication-review-queue">
      <div>
        <h3 className="text-lg font-semibold text-text-primary">
          {t('marketplace_management.plugin_publications.title')}
        </h3>
        <p className="mt-1 text-sm text-text-muted">
          {t('marketplace_management.plugin_publications.description')}
        </p>
      </div>

      <Card className="space-y-3 p-4" data-testid="plugin-publication-review-filters">
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_180px_180px]">
          <div className="relative min-w-0">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('marketplace_management.plugin_publications.filters.search')}
              className="h-11 pl-10"
              data-testid="plugin-publication-review-filter-search"
            />
          </div>
          <Input
            value={submitter}
            onChange={event => setSubmitter(event.target.value)}
            placeholder={t('marketplace_management.plugin_publications.filters.submitter')}
            className="h-11"
            data-testid="plugin-publication-review-filter-submitter"
          />
          <Select
            value={statusFilter}
            onValueChange={value => {
              const nextStatus = value as PluginPublicationStatus | 'all'
              setPage(1)
              setStatusFilter(nextStatus)
              replaceUrlParams({
                page: null,
                status: nextStatus === DEFAULT_STATUS ? null : nextStatus,
              })
            }}
          >
            <SelectTrigger className="h-11" data-testid="plugin-publication-review-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map(status => (
                <SelectItem key={status} value={status}>
                  {status === 'all'
                    ? t('marketplace_management.plugin_publications.filters.all_statuses')
                    : t(`marketplace_management.plugin_publications.statuses.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-3 lg:grid-cols-[180px_minmax(240px,1fr)_44px] lg:items-end">
          <Select
            value={riskFilter}
            onValueChange={value => {
              const nextRisk = value as PluginPublicationRiskLevel | 'all'
              setPage(1)
              setRiskFilter(nextRisk)
              replaceUrlParams({
                page: null,
                risk: nextRisk === 'all' ? null : nextRisk,
              })
            }}
          >
            <SelectTrigger className="h-11" data-testid="plugin-publication-review-filter-risk">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_FILTERS.map(risk => (
                <SelectItem key={risk} value={risk}>
                  {risk === 'all'
                    ? t('marketplace_management.plugin_publications.filters.all_risks')
                    : t(`marketplace_management.plugin_publications.risks.${risk}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto_1fr] sm:items-center">
            <Label
              htmlFor="plugin-publication-submitted-after"
              className="flex items-center gap-1.5 text-xs text-text-muted"
            >
              <CalendarRange className="h-3.5 w-3.5" aria-hidden />
              {t('marketplace_management.plugin_publications.filters.submitted_after')}
            </Label>
            <Input
              id="plugin-publication-submitted-after"
              type="date"
              value={submittedAfter}
              max={submittedBefore || undefined}
              onChange={event => {
                setPage(1)
                setSubmittedAfter(event.target.value)
                replaceUrlParams({
                  page: null,
                  submittedAfter: event.target.value || null,
                })
              }}
              className="h-11"
              data-testid="plugin-publication-review-filter-submitted-after"
            />
            <Label
              htmlFor="plugin-publication-submitted-before"
              className="text-xs text-text-muted"
            >
              {t('marketplace_management.plugin_publications.filters.submitted_before')}
            </Label>
            <Input
              id="plugin-publication-submitted-before"
              type="date"
              value={submittedBefore}
              min={submittedAfter || undefined}
              onChange={event => {
                setPage(1)
                setSubmittedBefore(event.target.value)
                replaceUrlParams({
                  page: null,
                  submittedBefore: event.target.value || null,
                })
              }}
              className="h-11"
              data-testid="plugin-publication-review-filter-submitted-before"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0"
            onClick={() => setRefreshVersion(current => current + 1)}
            disabled={loading}
            aria-label={t('marketplace_management.plugin_publications.actions.refresh')}
            data-testid="plugin-publication-review-refresh"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-4 text-sm text-text-muted">
        <span>
          {t('marketplace_management.plugin_publications.queue.total', {
            count: total,
          })}
        </span>
        <span>
          {t('marketplace_management.plugin_publications.pagination', {
            page,
            totalPages,
          })}
        </span>
      </div>

      {queueContent}

      {!loading && !loadFailed && totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={page <= 1}
            onClick={() => handlePageChange(page - 1)}
            data-testid="plugin-publication-review-previous-page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('marketplace_management.previous')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={page >= totalPages}
            onClick={() => handlePageChange(page + 1)}
            data-testid="plugin-publication-review-next-page"
          >
            {t('marketplace_management.next')}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ) : null}

      <PluginPublicationReviewDrawer
        requestId={selectedRequestId}
        onOpenChange={open => {
          if (!open) closeRequest()
        }}
        onRequestUpdated={handleRequestUpdated}
      />
    </div>
  )
}
