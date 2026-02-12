// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ClipboardCheck,
  FileText,
  CheckCircle,
  XCircle,
  Send,
  Clock,
  RefreshCw,
  BookOpen,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { getGraderDashboard, type GraderDashboardStats } from '@wecode/api/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function GraderDashboardContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [stats, setStats] = useState<GraderDashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getGraderDashboard()
      setStats(data)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard])

  if (loading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-64" />
        <div className="mb-8 grid gap-4 md:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <ClipboardCheck className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('roles.grader')}</h1>
            <p className="text-sm text-text-secondary">{t('grader.tasks_description')}</p>
          </div>
        </div>
        <Button variant="outline" onClick={loadDashboard}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('actions.refresh')}
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="mb-8 grid gap-4 md:grid-cols-5">
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => router.push('/evaluation/grader/tasks?status=0')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Clock className="h-8 w-8 text-yellow-500" />
              <div>
                <div className="text-sm text-text-secondary">{t('grading.status.pending')}</div>
                <div className="text-2xl font-semibold">{stats?.pending_count ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => router.push('/evaluation/grader/tasks?status=1')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-8 w-8 text-blue-500" />
              <div>
                <div className="text-sm text-text-secondary">{t('grading.status.running')}</div>
                <div className="text-2xl font-semibold">{stats?.running_count ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => router.push('/evaluation/grader/tasks?status=2')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-8 w-8 text-green-500" />
              <div>
                <div className="text-sm text-text-secondary">{t('grading.status.completed')}</div>
                <div className="text-2xl font-semibold">{stats?.completed_count ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => router.push('/evaluation/grader/tasks?status=3')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <XCircle className="h-8 w-8 text-red-500" />
              <div>
                <div className="text-sm text-text-secondary">{t('grading.status.failed')}</div>
                <div className="text-2xl font-semibold">{stats?.failed_count ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => router.push('/evaluation/grader/reports?status=4')}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Send className="h-8 w-8 text-primary" />
              <div>
                <div className="text-sm text-text-secondary">{t('grading.status.published')}</div>
                <div className="text-2xl font-semibold">{stats?.published_count ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card
          className="cursor-pointer transition-colors hover:border-primary"
          onClick={() => router.push('/evaluation/grader/tasks')}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              {t('grading.tasks')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>{t('grader.tasks_description')}</CardDescription>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-colors hover:border-primary"
          onClick={() => router.push('/evaluation/grader/tasks?status=0')}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {t('grader.pending_tasks')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>{t('grader.pending_tasks_description')}</CardDescription>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-colors hover:border-primary"
          onClick={() => router.push('/evaluation/grader/reports')}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              {t('grading.publish')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>{t('grader.publish_description')}</CardDescription>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-colors hover:border-primary"
          onClick={() => router.push('/evaluation/grader/topics')}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              {t('topics.browse')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>
              {stats?.total_topics ?? 0} {t('topics.title').toLowerCase()}
            </CardDescription>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function GraderDashboardPage() {
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
        <GraderDashboardContent />
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
          <GraderDashboardContent />
        </main>
      </div>
    </div>
  )
}
