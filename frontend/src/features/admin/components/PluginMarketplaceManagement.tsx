// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Package,
  RefreshCw,
  Search,
} from 'lucide-react'

import {
  adminApis,
  type AdminMarketplacePlugin,
  type AdminMarketplacePluginSource,
} from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tag } from '@/components/ui/tag'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn, formatUTC8DateTime } from '@/lib/utils'

const PAGE_SIZE = 20

type ListingFilter = 'all' | 'listed' | 'unlisted'
type SourceFilter = 'all' | AdminMarketplacePluginSource
type ScoreOrder = 'asc' | 'desc'

interface PluginDetailsPanelProps {
  plugin: AdminMarketplacePlugin | null
  saving: boolean
  onSave: (update: {
    description: string
    featured_rank: number
    is_listed: boolean
  }) => Promise<void>
}

function PluginMark({ plugin }: { plugin: AdminMarketplacePlugin }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
      <Package className="h-5 w-5 text-text-secondary" aria-hidden />
      <span className="sr-only">{plugin.display_name}</span>
    </div>
  )
}

function PluginDetailsPanel({ plugin, saving, onSave }: PluginDetailsPanelProps) {
  const { t } = useTranslation('admin')
  const [description, setDescription] = useState('')
  const [score, setScore] = useState('0')
  const [isListed, setIsListed] = useState(false)

  useEffect(() => {
    setDescription(plugin?.description ?? '')
    setScore(String(plugin?.featured_rank ?? 0))
    setIsListed(plugin?.is_listed ?? false)
  }, [plugin])

  if (!plugin) {
    return (
      <div className="flex min-h-80 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('marketplace_management.plugins.detail.select_prompt')}
      </div>
    )
  }

  const parsedScore = Number(score)
  const scoreValid = Number.isInteger(parsedScore) && parsedScore >= 0 && parsedScore <= 100
  const dirty =
    description !== plugin.description ||
    parsedScore !== plugin.featured_rank ||
    isListed !== plugin.is_listed

  const reset = () => {
    setDescription(plugin.description)
    setScore(String(plugin.featured_rank))
    setIsListed(plugin.is_listed)
  }

  return (
    <div className="flex h-full min-h-[34rem] flex-col" data-testid="plugin-management-detail">
      <div className="flex items-start gap-3 border-b border-border px-5 py-5">
        <PluginMark plugin={plugin} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold text-text-primary">
            {plugin.display_name}
          </h3>
          <p className="mt-0.5 truncate font-mono text-xs text-text-muted">{plugin.name}</p>
        </div>
      </div>

      <div className="flex-1 space-y-5 px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted">
            {t('marketplace_management.plugins.detail.source')}
          </span>
          <Tag variant={plugin.catalog_namespace === 'wework-official' ? 'info' : 'default'}>
            {t(`marketplace_management.plugins.sources.${plugin.catalog_namespace}`)}
          </Tag>
          <Tag variant={isListed ? 'success' : 'warning'}>
            {t(
              isListed
                ? 'marketplace_management.plugins.statuses.listed'
                : 'marketplace_management.plugins.statuses.unlisted'
            )}
          </Tag>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plugin-marketplace-description">
            {t('marketplace_management.plugins.detail.description')}
          </Label>
          <Textarea
            id="plugin-marketplace-description"
            value={description}
            maxLength={500}
            rows={5}
            onChange={event => setDescription(event.target.value)}
            data-testid="plugin-management-description"
          />
          <div className="text-right text-xs text-text-muted">{description.length}/500</div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plugin-marketplace-score">
            {t('marketplace_management.plugins.detail.score')}
          </Label>
          <Input
            id="plugin-marketplace-score"
            type="number"
            min={0}
            max={100}
            step={1}
            value={score}
            onChange={event => setScore(event.target.value)}
            aria-invalid={!scoreValid}
            data-testid="plugin-management-score"
          />
          <p className={cn('text-xs', scoreValid ? 'text-text-muted' : 'text-error')}>
            {t(
              scoreValid
                ? 'marketplace_management.plugins.detail.score_hint'
                : 'marketplace_management.plugins.detail.score_invalid'
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label>{t('marketplace_management.plugins.detail.listing')}</Label>
          <RadioGroup
            value={isListed ? 'listed' : 'unlisted'}
            onValueChange={value => setIsListed(value === 'listed')}
            className="gap-3 rounded-lg bg-surface px-4 py-3"
            data-testid="plugin-management-listing"
          >
            <div className="flex items-start gap-2.5">
              <RadioGroupItem
                id="plugin-marketplace-listing-listed"
                value="listed"
                data-testid="plugin-management-listing-listed"
              />
              <div className="min-w-0">
                <Label htmlFor="plugin-marketplace-listing-listed">
                  {t('marketplace_management.plugins.statuses.listed')}
                </Label>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('marketplace_management.plugins.detail.listed_hint')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <RadioGroupItem
                id="plugin-marketplace-listing-unlisted"
                value="unlisted"
                data-testid="plugin-management-listing-unlisted"
              />
              <div className="min-w-0">
                <Label htmlFor="plugin-marketplace-listing-unlisted">
                  {t('marketplace_management.plugins.statuses.unlisted')}
                </Label>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('marketplace_management.plugins.detail.unlisted_hint')}
                </p>
              </div>
            </div>
          </RadioGroup>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-border pt-4 text-xs">
          <dt className="text-text-muted">{t('marketplace_management.plugins.detail.version')}</dt>
          <dd className="text-text-secondary">{plugin.version ? `v${plugin.version}` : '-'}</dd>
          <dt className="text-text-muted">{t('marketplace_management.plugins.detail.author')}</dt>
          <dd className="text-text-secondary">{plugin.author || '-'}</dd>
          <dt className="text-text-muted">
            {t('marketplace_management.plugins.detail.created_at')}
          </dt>
          <dd className="text-text-secondary">{formatUTC8DateTime(plugin.created_at)}</dd>
          <dt className="text-text-muted">
            {t('marketplace_management.plugins.detail.updated_at')}
          </dt>
          <dd className="text-text-secondary">{formatUTC8DateTime(plugin.updated_at)}</dd>
        </dl>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
        {dirty ? (
          <span className="mr-auto text-xs text-warning">
            {t('marketplace_management.plugins.detail.unsaved')}
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={reset}
          disabled={!dirty || saving}
          data-testid="plugin-management-cancel"
        >
          {t('marketplace_management.plugins.actions.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!dirty || !scoreValid || saving}
          onClick={() => onSave({ description, featured_rank: parsedScore, is_listed: isListed })}
          data-testid="plugin-management-save"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {t('marketplace_management.plugins.actions.save')}
        </Button>
      </div>
    </div>
  )
}

export default function PluginMarketplaceManagement() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [items, setItems] = useState<AdminMarketplacePlugin[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [listingStatus, setListingStatus] = useState<ListingFilter>('all')
  const [scoreOrder, setScoreOrder] = useState<ScoreOrder>('desc')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const loadRequestRef = useRef(0)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selectedPlugin = useMemo(
    () => items.find(item => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  )
  const pluginGroups = useMemo(
    () =>
      (['wework-official', 'enterprise'] as const)
        .map(namespace => ({
          namespace,
          items: items.filter(item => item.catalog_namespace === namespace),
        }))
        .filter(group => group.items.length > 0),
    [items]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setAppliedSearch(search.trim())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const loadPlugins = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const response = await adminApis.getMarketplacePlugins(page, PAGE_SIZE, {
        search: appliedSearch,
        source,
        listingStatus,
        scoreOrder,
      })
      if (requestId === loadRequestRef.current) {
        setItems(response.items)
        setTotal(response.total)
        setSelectedId(current =>
          response.items.some(item => item.id === current)
            ? current
            : (response.items[0]?.id ?? null)
        )
      }
    } catch {
      if (requestId === loadRequestRef.current) {
        setItems([])
        setTotal(0)
        setLoadFailed(true)
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false)
      }
    }
  }, [appliedSearch, listingStatus, page, scoreOrder, source])

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins, refreshVersion])

  const handleSave = async (update: {
    description: string
    featured_rank: number
    is_listed: boolean
  }) => {
    if (!selectedPlugin) return
    setSaving(true)
    try {
      const updated = await adminApis.updateMarketplacePlugin(selectedPlugin.id, update)
      setItems(previous =>
        previous
          .map(item => (item.id === updated.id ? updated : item))
          .sort((left, right) => {
            const delta = left.featured_rank - right.featured_rank
            return scoreOrder === 'asc' ? delta : -delta
          })
      )
      toast({ title: t('marketplace_management.plugins.saved') })
      if (
        (listingStatus === 'listed' && !updated.is_listed) ||
        (listingStatus === 'unlisted' && updated.is_listed)
      ) {
        await loadPlugins()
      }
    } catch {
      toast({
        title: t('marketplace_management.plugins.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const resetFilters = () => {
    setPage(1)
    setSource('all')
    setListingStatus('all')
  }

  return (
    <div data-testid="plugin-marketplace-management">
      <div className="overflow-hidden rounded-xl border border-border bg-base">
        <div className="grid min-h-[42rem] xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
          <section className="min-w-0 xl:border-r xl:border-border">
            <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_10rem_10rem_auto]">
              <div className="relative min-w-0 sm:col-span-2 lg:col-span-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder={t('marketplace_management.plugins.filters.search')}
                  className="h-11 pl-10"
                  data-testid="plugin-management-search"
                />
              </div>
              <Select
                value={source}
                onValueChange={value => {
                  setPage(1)
                  setSource(value as SourceFilter)
                }}
              >
                <SelectTrigger className="h-11" data-testid="plugin-management-source-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="plugin-management-source-all">
                    {t('marketplace_management.plugins.filters.all_sources')}
                  </SelectItem>
                  <SelectItem
                    value="wework-official"
                    data-testid="plugin-management-source-official"
                  >
                    {t('marketplace_management.plugins.sources.wework-official')}
                  </SelectItem>
                  <SelectItem value="enterprise" data-testid="plugin-management-source-enterprise">
                    {t('marketplace_management.plugins.sources.enterprise')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={listingStatus}
                onValueChange={value => {
                  setPage(1)
                  setListingStatus(value as ListingFilter)
                }}
              >
                <SelectTrigger className="h-11" data-testid="plugin-management-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="plugin-management-status-all">
                    {t('marketplace_management.plugins.filters.all_statuses')}
                  </SelectItem>
                  <SelectItem value="listed" data-testid="plugin-management-status-listed">
                    {t('marketplace_management.plugins.statuses.listed')}
                  </SelectItem>
                  <SelectItem value="unlisted" data-testid="plugin-management-status-unlisted">
                    {t('marketplace_management.plugins.statuses.unlisted')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={() => setRefreshVersion(current => current + 1)}
                disabled={loading}
                aria-label={t('marketplace_management.plugins.actions.refresh')}
                data-testid="plugin-management-refresh"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
              </Button>
            </div>

            {loadFailed ? (
              <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-4 text-center">
                <p className="text-sm text-text-muted">
                  {t('marketplace_management.plugins.load_failed')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadPlugins()}
                  data-testid="plugin-management-retry"
                >
                  {t('marketplace_management.plugins.actions.retry')}
                </Button>
              </div>
            ) : loading ? (
              <div className="flex min-h-80 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
              </div>
            ) : items.length === 0 ? (
              <div className="flex min-h-80 flex-col items-center justify-center gap-2 px-4 text-center">
                <Package className="h-8 w-8 text-text-muted" aria-hidden />
                <p className="font-medium text-text-primary">
                  {t('marketplace_management.plugins.empty')}
                </p>
                <p className="text-sm text-text-muted">
                  {t('marketplace_management.plugins.empty_description')}
                </p>
                {(source !== 'all' || listingStatus !== 'all') && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetFilters}
                    data-testid="plugin-management-reset-filters"
                  >
                    {t('marketplace_management.plugins.actions.reset_filters')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="plugin-management-table">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="min-w-56 px-4">
                        {t('marketplace_management.plugins.columns.plugin')}
                      </TableHead>
                      <TableHead className="min-w-32 px-3 max-[1535px]:hidden">
                        {t('marketplace_management.plugins.columns.source')}
                      </TableHead>
                      <TableHead className="min-w-28 px-3">
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => {
                            setPage(1)
                            setScoreOrder(current => (current === 'desc' ? 'asc' : 'desc'))
                          }}
                          data-testid="plugin-management-score-sort"
                        >
                          {t('marketplace_management.plugins.columns.score')}
                          {scoreOrder === 'desc' ? (
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="min-w-24 px-3">
                        {t('marketplace_management.plugins.columns.status')}
                      </TableHead>
                      <TableHead className="min-w-40 px-3 max-[1535px]:hidden">
                        {t('marketplace_management.plugins.columns.updated_at')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pluginGroups.map(group => (
                      <Fragment key={group.namespace}>
                        <TableRow className="bg-surface/60 hover:bg-surface/60">
                          <TableCell
                            colSpan={5}
                            className="px-4 py-2 text-xs font-medium text-text-secondary"
                          >
                            {t(`marketplace_management.plugins.sources.${group.namespace}`)} (
                            {group.items.length})
                          </TableCell>
                        </TableRow>
                        {group.items.map(item => (
                          <TableRow
                            key={item.id}
                            tabIndex={0}
                            aria-selected={item.id === selectedPlugin?.id}
                            className={cn(
                              'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                              item.id === selectedPlugin?.id &&
                                'border-l-2 border-l-primary bg-primary/5 hover:bg-primary/5'
                            )}
                            onClick={() => setSelectedId(item.id)}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                setSelectedId(item.id)
                              }
                            }}
                            data-testid={`plugin-management-row-${item.id}`}
                          >
                            <TableCell className="px-4 py-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <PluginMark plugin={item} />
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-text-primary">
                                    {item.display_name}
                                  </p>
                                  <p className="truncate font-mono text-xs text-text-muted">
                                    {item.name}
                                  </p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="px-3 py-3 max-[1535px]:hidden">
                              <Tag
                                variant={
                                  item.catalog_namespace === 'wework-official' ? 'info' : 'default'
                                }
                              >
                                {t(
                                  `marketplace_management.plugins.sources.${item.catalog_namespace}`
                                )}
                              </Tag>
                            </TableCell>
                            <TableCell className="px-3 py-3 tabular-nums text-text-secondary">
                              {item.featured_rank}
                            </TableCell>
                            <TableCell className="px-3 py-3">
                              <Tag variant={item.is_listed ? 'success' : 'warning'}>
                                {t(
                                  item.is_listed
                                    ? 'marketplace_management.plugins.statuses.listed'
                                    : 'marketplace_management.plugins.statuses.unlisted'
                                )}
                              </Tag>
                            </TableCell>
                            <TableCell className="px-3 py-3 text-xs text-text-muted max-[1535px]:hidden">
                              {formatUTC8DateTime(item.updated_at)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-text-muted">
              <span>{t('marketplace_management.plugins.total', { count: total })}</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 md:h-9 md:w-9"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(current => current - 1)}
                  aria-label={t('marketplace_management.previous')}
                  data-testid="plugin-management-previous-page"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </Button>
                <span>{t('marketplace_management.pagination', { page, totalPages })}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 md:h-9 md:w-9"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage(current => current + 1)}
                  aria-label={t('marketplace_management.next')}
                  data-testid="plugin-management-next-page"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          </section>

          <aside className="min-w-0 border-t border-border bg-base xl:border-t-0">
            <PluginDetailsPanel plugin={selectedPlugin} saving={saving} onSave={handleSave} />
          </aside>
        </div>
      </div>
    </div>
  )
}
