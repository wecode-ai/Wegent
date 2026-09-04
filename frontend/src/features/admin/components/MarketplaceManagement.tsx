// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppWindow,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'

import {
  adminApis,
  type AdminMarketplaceExampleConversation,
  type AdminMarketplaceResource,
  type AdminMarketplaceResourceType,
  type AdminMarketplaceSmartApp,
} from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExampleConversationsEditor } from '@/features/resource-library/components/ExampleConversationsEditor'
import { ResourceIcon } from '@/features/resource-library/components/ResourceIcon'
import { MarketplaceTagSelector } from '@/features/resource-library/components/MarketplaceTagSelector'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50
const FEATURED_RECOMMENDATION_SCORE = 80

interface MarketplaceManagementProps {
  mode?: 'wegent' | 'smart-app'
}

type MarketplaceManagementItem = AdminMarketplaceResource & {
  is_listed?: boolean
  icon_url?: string
  description_md?: string
  marketplace_tags?: string[]
  needs_metadata?: boolean
}

type SmartAppListingFilter = 'all' | 'listed' | 'unlisted'
type SmartAppSourceFilter = 'all' | 'official' | 'user'

function markdownPreview(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`#>*_~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function smartAppToManagementItem(item: AdminMarketplaceSmartApp): MarketplaceManagementItem {
  return {
    id: item.id,
    resource_type: 'smart_app',
    name: item.name,
    display_name: item.display_name,
    description: item.summary || null,
    description_md: item.description_md,
    marketplace_tags: item.tags,
    icon_url: item.icon_url,
    publisher_user_name: item.publisher_user_name,
    is_system: item.is_system,
    recommendation_score: item.featured_rank,
    is_listed: item.is_listed,
    needs_metadata: item.needs_metadata,
    example_conversations: [],
  }
}

export default function MarketplaceManagement({ mode = 'wegent' }: MarketplaceManagementProps) {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const isSmartAppManagement = mode === 'smart-app'
  const [resourceType, setResourceType] = useState<AdminMarketplaceResourceType>(
    isSmartAppManagement ? 'smart_app' : 'agent'
  )
  const [items, setItems] = useState<MarketplaceManagementItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [savingScoreIds, setSavingScoreIds] = useState<Set<number>>(() => new Set())
  const [savingListingIds, setSavingListingIds] = useState<Set<number>>(() => new Set())
  const [savingExampleIds, setSavingExampleIds] = useState<Set<number>>(() => new Set())
  const [smartAppSearch, setSmartAppSearch] = useState('')
  const [debouncedSmartAppSearch, setDebouncedSmartAppSearch] = useState('')
  const [smartAppListingFilter, setSmartAppListingFilter] = useState<SmartAppListingFilter>('all')
  const [smartAppSourceFilter, setSmartAppSourceFilter] = useState<SmartAppSourceFilter>('all')
  const [importingOfficialApp, setImportingOfficialApp] = useState(false)
  const [editingMetadataItem, setEditingMetadataItem] = useState<MarketplaceManagementItem | null>(
    null
  )
  const [metadataSummary, setMetadataSummary] = useState('')
  const [metadataDescription, setMetadataDescription] = useState('')
  const [metadataTags, setMetadataTags] = useState<string[]>([])
  const [metadataIcon, setMetadataIcon] = useState<File | null>(null)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [deletingSmartApp, setDeletingSmartApp] = useState(false)
  const [deleteSmartAppItem, setDeleteSmartAppItem] = useState<MarketplaceManagementItem | null>(
    null
  )
  const [editingScoreItemId, setEditingScoreItemId] = useState<number | null>(null)
  const [recommendationScoreDraft, setRecommendationScoreDraft] = useState('0')
  const [editingExampleItemId, setEditingExampleItemId] = useState<number | null>(null)
  const [exampleConversations, setExampleConversations] = useState<
    Record<number, AdminMarketplaceExampleConversation[]>
  >({})
  const officialAppInputRef = useRef<HTMLInputElement>(null)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const editingScoreItem = items.find(item => item.id === editingScoreItemId) || null
  const editingExampleItem = items.find(item => item.id === editingExampleItemId) || null
  const parsedRecommendationScore = Number(recommendationScoreDraft)
  const recommendationScoreValid =
    Number.isInteger(parsedRecommendationScore) &&
    parsedRecommendationScore >= 0 &&
    parsedRecommendationScore <= 100

  useEffect(() => {
    if (!isSmartAppManagement) return
    const timer = window.setTimeout(() => {
      setPage(1)
      setDebouncedSmartAppSearch(smartAppSearch.trim())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [isSmartAppManagement, smartAppSearch])

  const loadResources = useCallback(async () => {
    setLoading(true)
    try {
      const response =
        resourceType === 'smart_app'
          ? await adminApis
              .getMarketplaceSmartApps(page, PAGE_SIZE, {
                search: debouncedSmartAppSearch,
                listingStatus: smartAppListingFilter,
                source: smartAppSourceFilter,
              })
              .then(result => ({
                ...result,
                items: result.items.map(smartAppToManagementItem),
              }))
          : await adminApis.getMarketplaceResources(resourceType, page, PAGE_SIZE)
      setItems(response.items)
      setTotal(response.total)
      setExampleConversations(
        Object.fromEntries(response.items.map(item => [item.id, item.example_conversations]))
      )
    } catch {
      setItems([])
      setTotal(0)
      toast({
        title: t('marketplace_management.load_failed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [
    debouncedSmartAppSearch,
    page,
    resourceType,
    smartAppListingFilter,
    smartAppSourceFilter,
    t,
    toast,
  ])

  useEffect(() => {
    void loadResources()
  }, [loadResources])

  const handleTypeChange = (value: string) => {
    setResourceType(value as AdminMarketplaceResourceType)
    setPage(1)
    setEditingScoreItemId(null)
    setEditingExampleItemId(null)
  }

  const openRecommendationScoreDialog = (item: AdminMarketplaceResource) => {
    setRecommendationScoreDraft(String(item.recommendation_score))
    setEditingScoreItemId(item.id)
  }

  const handleRecommendationScoreSave = async (item: AdminMarketplaceResource) => {
    if (!recommendationScoreValid) return
    setSavingScoreIds(previous => new Set(previous).add(item.id))
    try {
      const updated =
        item.resource_type === 'smart_app'
          ? await adminApis
              .updateMarketplaceSmartApp(item.id, {
                featured_rank: parsedRecommendationScore,
              })
              .then(smartApp => ({
                ...item,
                display_name: smartApp.display_name,
                description: smartApp.summary || null,
                description_md: smartApp.description_md,
                icon_url: smartApp.icon_url,
                publisher_user_name: smartApp.publisher_user_name,
                is_system: smartApp.is_system,
                recommendation_score: smartApp.featured_rank,
                is_listed: smartApp.is_listed,
              }))
          : await adminApis.updateMarketplaceResource(item.id, {
              recommendation_score: parsedRecommendationScore,
            })
      setItems(previous => previous.map(current => (current.id === updated.id ? updated : current)))
      toast({
        title: t('marketplace_management.recommendation_score_saved'),
      })
      setEditingScoreItemId(null)
    } catch {
      toast({
        title: t('marketplace_management.recommendation_score_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSavingScoreIds(previous => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    }
  }

  const handleListingToggle = async (item: MarketplaceManagementItem) => {
    if (item.resource_type !== 'smart_app') return
    setSavingListingIds(previous => new Set(previous).add(item.id))
    try {
      const smartApp = await adminApis.updateMarketplaceSmartApp(item.id, {
        is_listed: !item.is_listed,
      })
      setItems(previous =>
        previous.map(current =>
          current.id === item.id
            ? {
                ...current,
                is_listed: smartApp.is_listed,
                recommendation_score: smartApp.featured_rank,
              }
            : current
        )
      )
      toast({
        title: t(
          smartApp.is_listed
            ? 'marketplace_management.listing_enabled'
            : 'marketplace_management.listing_disabled'
        ),
      })
    } catch {
      toast({
        title: t('marketplace_management.listing_update_failed'),
        variant: 'destructive',
      })
    } finally {
      setSavingListingIds(previous => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    }
  }

  const openMetadataDialog = (item: MarketplaceManagementItem) => {
    setMetadataSummary(item.description || '')
    setMetadataDescription(item.description_md || item.description || '')
    setMetadataTags(item.marketplace_tags || [])
    setMetadataIcon(null)
    setEditingMetadataItem(item)
  }

  const handleOfficialAppImport = async (packageFile: File) => {
    setImportingOfficialApp(true)
    try {
      const imported = await adminApis.importOfficialMarketplaceSmartApp(packageFile)
      const importedItem = smartAppToManagementItem(imported)
      toast({
        title: t(
          imported.needs_metadata
            ? 'marketplace_management.official_import_needs_metadata'
            : 'marketplace_management.official_import_success'
        ),
      })
      if (page === 1) {
        await loadResources()
      } else {
        setPage(1)
      }
      if (imported.needs_metadata) openMetadataDialog(importedItem)
    } catch (error) {
      toast({
        title: t('marketplace_management.official_import_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setImportingOfficialApp(false)
    }
  }

  const handleMetadataSave = async (item: MarketplaceManagementItem) => {
    setSavingMetadata(true)
    try {
      const updated = await adminApis.updateOfficialMarketplaceSmartAppMetadata(item.id, {
        summary: metadataSummary.trim(),
        descriptionMd: metadataDescription.trim(),
        tags: metadataTags,
        icon: metadataIcon,
      })
      const updatedItem = smartAppToManagementItem(updated)
      setItems(previous =>
        previous.map(current => (current.id === updatedItem.id ? updatedItem : current))
      )
      setEditingMetadataItem(null)
      toast({ title: t('marketplace_management.metadata_saved') })
    } catch (error) {
      toast({
        title: t('marketplace_management.metadata_save_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSavingMetadata(false)
    }
  }

  const handleOfficialSmartAppDelete = async (item: MarketplaceManagementItem) => {
    setDeletingSmartApp(true)
    try {
      await adminApis.deleteOfficialMarketplaceSmartApp(item.id)
      setDeleteSmartAppItem(null)
      toast({ title: t('marketplace_management.delete_success') })
      if (items.length === 1 && page > 1) {
        setPage(current => current - 1)
      } else {
        await loadResources()
      }
    } catch (error) {
      toast({
        title: t('marketplace_management.delete_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDeletingSmartApp(false)
    }
  }

  const handleExampleUrlSave = async (item: AdminMarketplaceResource) => {
    setSavingExampleIds(previous => new Set(previous).add(item.id))
    try {
      const updated = await adminApis.updateMarketplaceResource(item.id, {
        example_conversations: (exampleConversations[item.id] || []).map(example => ({
          title: example.title.trim(),
          url: example.url.trim(),
        })),
      })
      setItems(previous => previous.map(current => (current.id === updated.id ? updated : current)))
      setExampleConversations(previous => ({
        ...previous,
        [item.id]: updated.example_conversations,
      }))
      toast({
        title: t('marketplace_management.example_conversation_saved'),
      })
      setEditingExampleItemId(null)
    } catch {
      toast({
        title: t('marketplace_management.example_conversation_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSavingExampleIds(previous => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    }
  }

  const renderList = () => {
    if (loading) {
      return (
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" aria-hidden />
        </div>
      )
    }
    if (items.length === 0) {
      return (
        <div className="flex min-h-64 items-center justify-center text-sm text-text-muted">
          {t('marketplace_management.empty')}
        </div>
      )
    }

    return (
      <div
        className="grid grid-cols-1 content-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="marketplace-management-list"
      >
        {items.map(item => {
          const exampleCount = (exampleConversations[item.id] || []).length
          const isFeatured = item.recommendation_score >= FEATURED_RECOMMENDATION_SCORE
          const sourceLabel = item.is_system
            ? t('marketplace_management.system_source')
            : item.publisher_user_name
              ? t('marketplace_management.publisher', {
                  name: item.publisher_user_name,
                })
              : t('marketplace_management.user_source')

          return (
            <Card
              key={item.id}
              className="flex min-h-[196px] flex-col gap-3 overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
              data-testid={`marketplace-management-item-${item.id}`}
            >
              <div className="flex min-w-0 items-start gap-3">
                {item.resource_type === 'smart_app' ? (
                  <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-text-secondary">
                    <AppWindow className="h-5 w-5" aria-hidden />
                    {item.icon_url ? (
                      // Smart App icons are signed internal marketplace assets.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.icon_url}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                        aria-hidden="true"
                        onError={event => {
                          event.currentTarget.style.display = 'none'
                        }}
                        data-testid={`marketplace-smart-app-icon-${item.id}`}
                      />
                    ) : null}
                  </div>
                ) : (
                  <ResourceIcon
                    resourceType={item.resource_type}
                    name={item.display_name}
                    size={item.resource_type === 'agent' ? 'sm' : 'md'}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold text-text-primary">
                      {item.display_name}
                    </h3>
                    {item.resource_type === 'smart_app' ? (
                      <Badge
                        variant={item.is_listed ? 'success' : 'secondary'}
                        size="sm"
                        className="shrink-0"
                      >
                        {t(
                          item.is_listed
                            ? 'marketplace_management.listed'
                            : 'marketplace_management.unlisted'
                        )}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-muted">{sourceLabel}</p>
                </div>
                {item.resource_type === 'smart_app' && item.is_system ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          '-mr-1 -mt-1 h-11 w-11 shrink-0 text-text-muted hover:bg-hover hover:text-text-primary md:h-8 md:w-8',
                          item.needs_metadata &&
                            'bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning'
                        )}
                        aria-label={t('marketplace_management.more_actions')}
                        title={t('marketplace_management.more_actions')}
                        data-testid={`marketplace-smart-app-more-${item.id}`}
                      >
                        <MoreHorizontal className="h-5 w-5" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        className="gap-2 py-2"
                        onSelect={() => openMetadataDialog(item)}
                        data-testid={`marketplace-smart-app-metadata-${item.id}`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t(
                          item.needs_metadata
                            ? 'marketplace_management.complete_metadata'
                            : 'marketplace_management.edit_metadata'
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        danger
                        className="gap-2 py-2"
                        onSelect={() => setDeleteSmartAppItem(item)}
                        data-testid={`marketplace-smart-app-delete-${item.id}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                        {t('marketplace_management.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
                {item.description || item.name}
              </p>
              {item.resource_type === 'smart_app' && item.description_md ? (
                <p
                  className="line-clamp-2 text-xs leading-5 text-text-muted"
                  title={markdownPreview(item.description_md)}
                  data-testid={`marketplace-smart-app-description-${item.id}`}
                >
                  {markdownPreview(item.description_md)}
                </p>
              ) : null}

              <div
                className={cn(
                  'mt-auto grid gap-2 border-t border-border/70 pt-3',
                  (item.resource_type === 'agent' && item.is_system) ||
                    item.resource_type === 'smart_app'
                    ? 'grid-cols-2'
                    : 'grid-cols-1'
                )}
              >
                {item.resource_type === 'agent' && item.is_system ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-11 min-w-0 gap-1.5 px-2 text-xs md:h-8',
                      exampleCount > 0 &&
                        'border-success/30 bg-success/10 text-success hover:bg-success/15'
                    )}
                    onClick={() => setEditingExampleItemId(item.id)}
                    data-testid={`marketplace-example-conversations-toggle-${item.id}`}
                  >
                    {exampleCount > 0 ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                    ) : (
                      <MessageSquareText className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">
                      {exampleCount > 0
                        ? t('marketplace_management.example_conversations_configured', {
                            count: exampleCount,
                          })
                        : t('marketplace_management.configure_example_conversations')}
                    </span>
                  </Button>
                ) : null}

                {item.resource_type === 'smart_app' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-11 min-w-0 gap-1.5 bg-surface px-2 text-xs hover:bg-hover md:h-9',
                      !item.is_listed &&
                        'border-success/30 text-success hover:bg-success/10 hover:text-success'
                    )}
                    disabled={savingListingIds.has(item.id)}
                    onClick={() => void handleListingToggle(item)}
                    data-testid={`marketplace-listing-toggle-${item.id}`}
                  >
                    {savingListingIds.has(item.id) ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                    ) : item.is_listed ? (
                      <EyeOff className="h-4 w-4 shrink-0" aria-hidden />
                    ) : (
                      <Eye className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">
                      {t(
                        item.is_listed
                          ? 'marketplace_management.unlist'
                          : 'marketplace_management.list'
                      )}
                    </span>
                  </Button>
                ) : null}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-11 min-w-0 gap-1.5 bg-surface px-2 text-xs hover:bg-hover md:h-9',
                    isFeatured &&
                      'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary'
                  )}
                  disabled={savingScoreIds.has(item.id)}
                  onClick={() => openRecommendationScoreDialog(item)}
                  data-testid={`marketplace-recommendation-score-${item.id}`}
                >
                  {savingScoreIds.has(item.id) ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <Star
                      className="h-4 w-4 shrink-0"
                      fill={isFeatured ? 'currentColor' : 'none'}
                      aria-hidden
                    />
                  )}
                  <span className="truncate">
                    {t('marketplace_management.recommendation_score_value', {
                      score: item.recommendation_score,
                    })}
                  </span>
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-5" data-testid="marketplace-management">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">
            {t(
              isSmartAppManagement
                ? 'marketplace_management.wework.smart_app_title'
                : 'marketplace_management.title'
            )}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t(
              isSmartAppManagement
                ? 'marketplace_management.wework.smart_app_description'
                : 'marketplace_management.description'
            )}
          </p>
        </div>
        {isSmartAppManagement ? (
          <div className="shrink-0">
            <input
              ref={officialAppInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              data-testid="marketplace-official-app-file"
              onChange={event => {
                const packageFile = event.target.files?.[0]
                event.target.value = ''
                if (packageFile) void handleOfficialAppImport(packageFile)
              }}
            />
            <Button
              type="button"
              variant="primary"
              className="h-11 w-full sm:w-auto"
              disabled={importingOfficialApp}
              onClick={() => officialAppInputRef.current?.click()}
              title={t('marketplace_management.import_official_app_hint')}
              data-testid="marketplace-official-app-import"
            >
              {importingOfficialApp ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-4 w-4" aria-hidden />
              )}
              {t(
                importingOfficialApp
                  ? 'marketplace_management.importing_official_app'
                  : 'marketplace_management.import_official_app'
              )}
            </Button>
          </div>
        ) : null}
      </div>

      {isSmartAppManagement ? (
        <div className="space-y-4">
          <Card className="p-3" data-testid="marketplace-smart-app-filters">
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_180px]">
              <div className="relative min-w-0">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                  aria-hidden
                />
                <Input
                  value={smartAppSearch}
                  onChange={event => setSmartAppSearch(event.target.value)}
                  placeholder={t('marketplace_management.smart_app_filters.search')}
                  className="h-11 pl-10"
                  data-testid="marketplace-smart-app-filter-search"
                />
              </div>
              <Select
                value={smartAppListingFilter}
                onValueChange={value => {
                  setPage(1)
                  setSmartAppListingFilter(value as SmartAppListingFilter)
                }}
              >
                <SelectTrigger className="h-11" data-testid="marketplace-smart-app-filter-listing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('marketplace_management.smart_app_filters.all_listing_statuses')}
                  </SelectItem>
                  <SelectItem value="listed">
                    {t('marketplace_management.smart_app_filters.listed')}
                  </SelectItem>
                  <SelectItem value="unlisted">
                    {t('marketplace_management.smart_app_filters.unlisted')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={smartAppSourceFilter}
                onValueChange={value => {
                  setPage(1)
                  setSmartAppSourceFilter(value as SmartAppSourceFilter)
                }}
              >
                <SelectTrigger className="h-11" data-testid="marketplace-smart-app-filter-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('marketplace_management.smart_app_filters.all_sources')}
                  </SelectItem>
                  <SelectItem value="official">
                    {t('marketplace_management.smart_app_filters.official')}
                  </SelectItem>
                  <SelectItem value="user">
                    {t('marketplace_management.smart_app_filters.user')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Card>
          {!loading && (
            <div className="text-right text-sm text-text-muted">
              {t('marketplace_management.resource_count', { count: total })}
            </div>
          )}
          {renderList()}
        </div>
      ) : (
        <Tabs value={resourceType} onValueChange={handleTypeChange}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList className="grid w-full grid-cols-2 border border-border bg-surface shadow-sm sm:w-auto sm:min-w-[20rem]">
              <TabsTrigger
                value="agent"
                className="data-[state=active]:bg-primary data-[state=active]:text-white"
                data-testid="marketplace-management-tab-agent"
              >
                <Bot className="mr-2 h-4 w-4" aria-hidden />
                {t('marketplace_management.agent_tab')}
              </TabsTrigger>
              <TabsTrigger
                value="skill"
                className="data-[state=active]:bg-primary data-[state=active]:text-white"
                data-testid="marketplace-management-tab-skill"
              >
                <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                {t('marketplace_management.skill_tab')}
              </TabsTrigger>
            </TabsList>
            {!loading && (
              <span className="text-sm text-text-muted">
                {t('marketplace_management.resource_count', { count: total })}
              </span>
            )}
          </div>
          <TabsContent value="agent" className="mt-4">
            {resourceType === 'agent' ? renderList() : null}
          </TabsContent>
          <TabsContent value="skill" className="mt-4">
            {resourceType === 'skill' ? renderList() : null}
          </TabsContent>
        </Tabs>
      )}

      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(current => current - 1)}
            data-testid="marketplace-management-previous-page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('marketplace_management.previous')}
          </Button>
          <span className="text-sm text-text-muted">
            {t('marketplace_management.pagination', { page, totalPages })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(current => current + 1)}
            data-testid="marketplace-management-next-page"
          >
            {t('marketplace_management.next')}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}

      <Dialog
        open={editingMetadataItem !== null}
        onOpenChange={open => {
          if (!open && !savingMetadata) setEditingMetadataItem(null)
        }}
      >
        <DialogContent
          className="max-h-[85vh] max-w-2xl overflow-y-auto"
          data-testid="marketplace-smart-app-metadata-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                editingMetadataItem?.needs_metadata
                  ? 'marketplace_management.complete_metadata_title'
                  : 'marketplace_management.edit_metadata_title'
              )}
            </DialogTitle>
            <DialogDescription>
              {editingMetadataItem?.display_name} ·{' '}
              {t('marketplace_management.metadata_description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="marketplace-smart-app-summary"
                className="text-sm font-medium text-text-primary"
              >
                {t('marketplace_management.metadata_summary')}
              </label>
              <Input
                id="marketplace-smart-app-summary"
                value={metadataSummary}
                maxLength={500}
                disabled={savingMetadata}
                onChange={event => setMetadataSummary(event.target.value)}
                data-testid="marketplace-smart-app-metadata-summary"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="marketplace-smart-app-description"
                className="text-sm font-medium text-text-primary"
              >
                {t('marketplace_management.metadata_detail')}
              </label>
              <Textarea
                id="marketplace-smart-app-description"
                value={metadataDescription}
                maxLength={8192}
                rows={7}
                disabled={savingMetadata}
                onChange={event => setMetadataDescription(event.target.value)}
                data-testid="marketplace-smart-app-metadata-description"
              />
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium text-text-primary">
                {t('marketplace_management.metadata_tags')}
              </span>
              <MarketplaceTagSelector
                value={metadataTags}
                onChange={setMetadataTags}
                disabled={savingMetadata}
              />
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium text-text-primary">
                {t('marketplace_management.metadata_icon')}
              </span>
              <div className="flex items-center gap-3">
                {editingMetadataItem?.icon_url ? (
                  // Smart App icons are signed internal marketplace assets.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={editingMetadataItem.icon_url}
                    alt=""
                    className="h-12 w-12 rounded-xl border border-border object-cover"
                    aria-hidden="true"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted text-text-muted">
                    <AppWindow className="h-5 w-5" aria-hidden />
                  </div>
                )}
                <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">
                  <Upload className="mr-2 h-4 w-4" aria-hidden />
                  {t('marketplace_management.choose_icon')}
                  <input
                    type="file"
                    accept="image/png,image/webp"
                    className="hidden"
                    disabled={savingMetadata}
                    onChange={event => setMetadataIcon(event.target.files?.[0] || null)}
                    data-testid="marketplace-smart-app-metadata-icon"
                  />
                </label>
                <span className="min-w-0 truncate text-sm text-text-muted">
                  {metadataIcon?.name || t('marketplace_management.icon_optional_hint')}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={savingMetadata}
              onClick={() => setEditingMetadataItem(null)}
              data-testid="marketplace-smart-app-metadata-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={
                !editingMetadataItem ||
                !metadataSummary.trim() ||
                !metadataDescription.trim() ||
                metadataTags.length === 0 ||
                savingMetadata
              }
              onClick={() => editingMetadataItem && void handleMetadataSave(editingMetadataItem)}
              data-testid="marketplace-smart-app-metadata-save"
            >
              {savingMetadata ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteSmartAppItem !== null}
        onOpenChange={open => {
          if (!open && !deletingSmartApp) setDeleteSmartAppItem(null)
        }}
      >
        <AlertDialogContent data-testid="marketplace-smart-app-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('marketplace_management.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('marketplace_management.delete_description', {
                name: deleteSmartAppItem?.display_name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSmartApp}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingSmartApp || !deleteSmartAppItem}
              onClick={() =>
                deleteSmartAppItem && void handleOfficialSmartAppDelete(deleteSmartAppItem)
              }
              data-testid="marketplace-smart-app-delete-confirm"
            >
              {deletingSmartApp ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('marketplace_management.confirm_delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editingScoreItem !== null}
        onOpenChange={open => {
          if (!open) setEditingScoreItemId(null)
        }}
      >
        <DialogContent className="max-w-md" data-testid="marketplace-recommendation-score-dialog">
          <DialogHeader>
            <DialogTitle>{t('marketplace_management.edit_recommendation_score')}</DialogTitle>
            <DialogDescription>
              {editingScoreItem?.display_name} ·{' '}
              {t('marketplace_management.recommendation_score_description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  score: 0,
                  label: t('marketplace_management.score_none'),
                },
                {
                  score: FEATURED_RECOMMENDATION_SCORE,
                  label: t('marketplace_management.score_featured'),
                },
                {
                  score: 90,
                  label: t('marketplace_management.score_premium'),
                },
              ].map(option => (
                <Button
                  key={option.score}
                  type="button"
                  variant={parsedRecommendationScore === option.score ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setRecommendationScoreDraft(String(option.score))}
                  data-testid={`marketplace-recommendation-score-option-${option.score}`}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="marketplace-recommendation-score"
                className="text-sm font-medium text-text-primary"
              >
                {t('marketplace_management.recommendation_score')}
              </label>
              <Input
                id="marketplace-recommendation-score"
                type="number"
                min={0}
                max={100}
                step={1}
                value={recommendationScoreDraft}
                onChange={event => setRecommendationScoreDraft(event.target.value)}
                data-testid="marketplace-recommendation-score-input"
              />
              <p className="text-xs leading-5 text-text-muted">
                {t('marketplace_management.recommendation_score_hint')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingScoreItemId(null)}
              data-testid="marketplace-recommendation-score-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={
                !editingScoreItem ||
                !recommendationScoreValid ||
                savingScoreIds.has(editingScoreItem.id)
              }
              onClick={() =>
                editingScoreItem && void handleRecommendationScoreSave(editingScoreItem)
              }
              data-testid="marketplace-recommendation-score-save"
            >
              {editingScoreItem && savingScoreIds.has(editingScoreItem.id) ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingExampleItem !== null}
        onOpenChange={open => {
          if (!open) setEditingExampleItemId(null)
        }}
      >
        <DialogContent
          className="max-h-[85vh] max-w-2xl overflow-y-auto"
          data-testid="marketplace-example-conversations-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('marketplace_management.edit_example_conversations')}</DialogTitle>
            <DialogDescription>
              {editingExampleItem?.display_name} ·{' '}
              {t('marketplace_management.example_conversation_description')}
            </DialogDescription>
          </DialogHeader>

          {editingExampleItem && (
            <ExampleConversationsEditor
              value={exampleConversations[editingExampleItem.id] || []}
              onChange={value =>
                setExampleConversations(previous => ({
                  ...previous,
                  [editingExampleItem.id]: value,
                }))
              }
              testIdPrefix={`marketplace-example-conversations-${editingExampleItem.id}`}
            />
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="primary"
              disabled={
                !editingExampleItem ||
                savingExampleIds.has(editingExampleItem.id) ||
                (exampleConversations[editingExampleItem.id] || []).some(
                  example => !example.title.trim() || !example.url.trim()
                )
              }
              onClick={() => editingExampleItem && void handleExampleUrlSave(editingExampleItem)}
              data-testid={
                editingExampleItem
                  ? `marketplace-example-conversations-save-${editingExampleItem.id}`
                  : undefined
              }
            >
              {editingExampleItem && savingExampleIds.has(editingExampleItem.id) ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('marketplace_management.save_example_conversation')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
