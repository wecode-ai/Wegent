// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Search, Eye, EyeOff, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { listMyTopics } from '@wecode/api/evaluation-author'
import type { Topic } from '@wecode/types/evaluation'
import {
  TopicStatus,
  TopicVisibility,
  getStatusLabel,
  getVisibilityLabel,
} from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function AuthorTopicsContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [topics, setTopics] = useState<Topic[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [visibility, setVisibility] = useState<string>('all')

  const loadTopics = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listMyTopics({
        page,
        limit: 20,
        search: search || undefined,
        visibility: visibility === 'all' ? undefined : visibility,
      })
      setTopics(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [page, search, visibility, toast, t])

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
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">
            {t('creator.my_topics', 'My Topics')}
          </h1>
          <p className="text-sm text-text-secondary">
            {t('creator.my_topics_description', 'Manage your evaluation topics')}
          </p>
        </div>
        <Link href="/evaluation/author/topics/new">
          <Button variant="primary">
            <Plus className="mr-2 h-4 w-4" />
            {t('topics.create', 'Create Topic')}
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder={t('topics.search_placeholder', 'Search topics...')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="max-w-xs"
          />
          <Button variant="outline" onClick={handleSearch}>
            <Search className="h-4 w-4" />
          </Button>
        </div>

        <Select value={visibility} onValueChange={setVisibility}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder={t('topics.visibility', 'Visibility')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common:all', 'All')}</SelectItem>
            <SelectItem value="public">{t('topics.public', 'Public')}</SelectItem>
            <SelectItem value="private">{t('topics.private', 'Private')}</SelectItem>
          </SelectContent>
        </Select>
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
          <h3 className="mb-2 text-lg font-medium text-text-primary">
            {t('topics.no_topics', 'No topics found')}
          </h3>
          <p className="mb-4 text-sm text-text-secondary">
            {search
              ? t('topics.no_search_results', 'Try adjusting your search terms')
              : t('topics.create_first', 'Create your first topic to get started')}
          </p>
          <Link href="/evaluation/author/topics/new">
            <Button variant="primary">
              <Plus className="mr-2 h-4 w-4" />
              {t('topics.create', 'Create Topic')}
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {topics.map(topic => (
            <Card
              key={topic.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => router.push(`/evaluation/author/topics/${topic.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-lg">{topic.name}</CardTitle>
                  <div className="flex gap-1">
                    <Badge
                      variant={
                        topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'
                      }
                    >
                      {topic.visibility === TopicVisibility.PUBLIC ? (
                        <Eye className="mr-1 h-3 w-3" />
                      ) : (
                        <EyeOff className="mr-1 h-3 w-3" />
                      )}
                      {getVisibilityLabel(topic.visibility)}
                    </Badge>
                    <Badge variant={topic.status === TopicStatus.PUBLISHED ? 'success' : 'info'}>
                      {getStatusLabel(topic.status, 'topic')}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {topic.description && (
                  <p className="mb-2 line-clamp-2 text-sm text-text-secondary">
                    {topic.description}
                  </p>
                )}
                <div className="flex items-center justify-between text-xs text-text-muted">
                  <span>
                    {topic.question_count ?? 0} {t('questions.title', 'questions')}
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
            {t('common:previous', 'Previous')}
          </Button>
          <span className="flex items-center px-4 text-sm text-text-secondary">
            {t('common:page', 'Page')} {page} / {Math.ceil(total / 20)}
          </span>
          <Button
            variant="outline"
            disabled={page >= Math.ceil(total / 20)}
            onClick={() => setPage(page + 1)}
          >
            {t('common:next', 'Next')}
          </Button>
        </div>
      )}
    </div>
  )
}

export default function AuthorTopicsPage() {
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col">
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="evaluation"
        />
        <AuthorTopicsContent />
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {isSidebarCollapsed ? (
        <CollapsedSidebarButtons
          onExpand={() => setIsSidebarCollapsed(false)}
          onNewTask={() => {}}
        />
      ) : (
        <ResizableSidebar
          minWidth={220}
          maxWidth={400}
          defaultWidth={280}
          storageKey="evaluation-sidebar-width"
        >
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="evaluation"
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          />
        </ResizableSidebar>
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNavigation activePage="evaluation" />
        <main className="flex-1 overflow-auto">
          <AuthorTopicsContent />
        </main>
      </div>
    </div>
  )
}
