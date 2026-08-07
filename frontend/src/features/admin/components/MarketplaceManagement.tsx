// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquareText,
  Sparkles,
  Star,
} from 'lucide-react'

import {
  adminApis,
  type AdminMarketplaceExampleConversation,
  type AdminMarketplaceResource,
  type AdminMarketplaceResourceType,
} from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ExampleConversationsEditor } from '@/features/resource-library/components/ExampleConversationsEditor'
import { ResourceIcon } from '@/features/resource-library/components/ResourceIcon'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50
const FEATURED_RECOMMENDATION_SCORE = 80

export default function MarketplaceManagement() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [resourceType, setResourceType] = useState<AdminMarketplaceResourceType>('agent')
  const [items, setItems] = useState<AdminMarketplaceResource[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [savingScoreIds, setSavingScoreIds] = useState<Set<number>>(() => new Set())
  const [savingExampleIds, setSavingExampleIds] = useState<Set<number>>(() => new Set())
  const [editingScoreItemId, setEditingScoreItemId] = useState<number | null>(null)
  const [recommendationScoreDraft, setRecommendationScoreDraft] = useState('0')
  const [editingExampleItemId, setEditingExampleItemId] = useState<number | null>(null)
  const [exampleConversations, setExampleConversations] = useState<
    Record<number, AdminMarketplaceExampleConversation[]>
  >({})
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const editingScoreItem = items.find(item => item.id === editingScoreItemId) || null
  const editingExampleItem = items.find(item => item.id === editingExampleItemId) || null
  const parsedRecommendationScore = Number(recommendationScoreDraft)
  const recommendationScoreValid =
    Number.isInteger(parsedRecommendationScore) &&
    parsedRecommendationScore >= 0 &&
    parsedRecommendationScore <= 100

  const loadResources = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getMarketplaceResources(resourceType, page, PAGE_SIZE)
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
  }, [page, resourceType, t, toast])

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
      const updated = await adminApis.updateMarketplaceResource(item.id, {
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
                <ResourceIcon
                  resourceType={item.resource_type}
                  name={item.display_name}
                  size={item.resource_type === 'agent' ? 'sm' : 'md'}
                />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-text-primary">{item.display_name}</h3>
                  <p className="mt-0.5 truncate text-xs text-text-muted">{sourceLabel}</p>
                </div>
              </div>

              <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
                {item.description || item.name}
              </p>

              <div
                className={cn(
                  'mt-auto grid gap-2 border-t border-border/70 pt-3',
                  item.resource_type === 'agent' && item.is_system ? 'grid-cols-2' : 'grid-cols-1'
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

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-11 min-w-0 gap-1.5 px-2 text-xs md:h-8',
                    isFeatured && 'border-primary/30 bg-primary/5 text-primary'
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
      <div className="border-b border-border pb-4">
        <h2 className="text-xl font-semibold text-text-primary">
          {t('marketplace_management.title')}
        </h2>
        <p className="mt-1 text-sm text-text-muted">{t('marketplace_management.description')}</p>
      </div>

      <Tabs value={resourceType} onValueChange={handleTypeChange}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="grid w-full grid-cols-2 border border-border bg-surface shadow-sm sm:w-auto sm:min-w-80">
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
