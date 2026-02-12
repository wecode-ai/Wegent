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
import { listTopics } from '@wecode/api/evaluation'
import type { Topic } from '@wecode/types/evaluation'
import {
  TopicStatus,
  TopicVisibility,
  getStatusLabel,
  getVisibilityLabel,
} from '@wecode/types/evaluation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function TopicsContent() {
  const router = useRouter()
  const { toast } = useToast()
  const [topics, setTopics] = useState<Topic[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [visibility, setVisibility] = useState<string>('all')
  const [myOnly, setMyOnly] = useState(false)

  const loadTopics = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listTopics({
        page,
        limit: 20,
        search: search || undefined,
        visibility: visibility === 'all' ? undefined : visibility,
        my_only: myOnly,
      })
      setTopics(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load topics',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [page, search, visibility, myOnly, toast])

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
          <h1 className="text-2xl font-semibold text-text-primary">Evaluation Topics</h1>
          <p className="text-sm text-text-secondary">Browse and manage evaluation topics</p>
        </div>
        <Link href="/evaluation/topics/new">
          <Button variant="primary">
            <Plus className="mr-2 h-4 w-4" />
            Create Topic
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search topics..."
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
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="private">Private</SelectItem>
          </SelectContent>
        </Select>

        <Button variant={myOnly ? 'default' : 'outline'} onClick={() => setMyOnly(!myOnly)}>
          {myOnly ? 'My Topics' : 'All Topics'}
        </Button>
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
          <h3 className="mb-2 text-lg font-medium text-text-primary">No topics found</h3>
          <p className="mb-4 text-sm text-text-secondary">
            {search ? 'Try adjusting your search terms' : 'Create your first topic to get started'}
          </p>
          <Link href="/evaluation/topics/new">
            <Button variant="primary">
              <Plus className="mr-2 h-4 w-4" />
              Create Topic
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {topics.map(topic => (
            <Card
              key={topic.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => router.push(`/evaluation/topics/${topic.id}`)}
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
                  <span>{topic.question_count ?? 0} questions</span>
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
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-text-secondary">
            Page {page} of {Math.ceil(total / 20)}
          </span>
          <Button
            variant="outline"
            disabled={page >= Math.ceil(total / 20)}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

export default function TopicsPage() {
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
        <TopicsContent />
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
          <TopicsContent />
        </main>
      </div>
    </div>
  )
}
