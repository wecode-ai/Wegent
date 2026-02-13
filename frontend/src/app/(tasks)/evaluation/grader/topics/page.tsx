// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Search, FileText, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { listGraderTopics } from '@wecode/api/evaluation'
import type { Topic } from '@wecode/types/evaluation'
import { TopicVisibility, getVisibilityLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function GraderTopicsContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [topics, setTopics] = useState<Topic[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')

  const loadTopics = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listGraderTopics({
        page,
        limit: 20,
        search: search || undefined,
      })
      setTopics(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [page, search, toast, t])

  useEffect(() => {
    loadTopics()
  }, [loadTopics])

  const handleSearch = () => {
    setPage(1)
    loadTopics()
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => router.push('/evaluation/grader')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('actions.back')}
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('topics.title')}</h1>
            <p className="text-sm text-text-secondary">{t('grader.tasks_description')}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder={t('topics.browse')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="max-w-xs"
          />
          <Button variant="outline" onClick={handleSearch}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Topics Grid */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="mb-2 h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : topics.length === 0 ? (
        <div className="py-12 text-center">
          <FileText className="mx-auto mb-4 h-12 w-12 text-text-muted" />
          <h3 className="mb-2 text-lg font-medium text-text-primary">{t('topics.no_topics')}</h3>
          <p className="text-sm text-text-secondary">
            {search ? t('topics.no_search_results') : t('grader.no_topics_available')}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {topics.map(topic => (
            <Card
              key={topic.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => router.push(`/evaluation/grader/topics/${topic.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-lg">{topic.name}</CardTitle>
                  <Badge
                    variant={topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'}
                  >
                    {getVisibilityLabel(topic.visibility)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {topic.description && (
                  <p className="mb-2 line-clamp-2 text-sm text-text-secondary">
                    {topic.description}
                  </p>
                )}
                <div className="flex items-center justify-between text-xs text-text-muted">
                  <span className="flex items-center gap-1">
                    <BarChart3 className="h-3 w-3" />
                    {topic.question_count ?? 0} {t('questions.title').toLowerCase()}
                  </span>
                  <span>{new Date(topic.updated_at).toLocaleDateString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > 20 && (
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
            {t('common.previous')}
          </Button>
          <span className="flex items-center px-4 text-sm text-text-secondary">
            {t('common.page')} {page} / {Math.ceil(total / 20)}
          </span>
          <Button
            variant="outline"
            disabled={page >= Math.ceil(total / 20)}
            onClick={() => setPage(page + 1)}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </div>
  )
}

export default function GraderTopicsPage() {
  return (
    <EvaluationPageLayout>
      <GraderTopicsContent />
    </EvaluationPageLayout>
  )
}
