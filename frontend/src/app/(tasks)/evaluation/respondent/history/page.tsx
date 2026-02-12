// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FileText, CheckCircle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { respondentListAnswerHistory, respondentListGradingReports } from '@wecode/api/evaluation'
import type { Answer, GradingTask } from '@wecode/types/evaluation'
import { getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function RespondentHistoryContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [answers, setAnswers] = useState<Answer[]>([])
  const [reports, setReports] = useState<GradingTask[]>([])
  const [answersTotal, setAnswersTotal] = useState(0)
  const [reportsTotal, setReportsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [answersPage, setAnswersPage] = useState(1)
  const [reportsPage, setReportsPage] = useState(1)

  const loadAnswers = useCallback(async () => {
    try {
      const response = await respondentListAnswerHistory({
        page: answersPage,
        limit: 20,
        latest_only: true,
      })
      setAnswers(response.items)
      setAnswersTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }, [answersPage, toast, t])

  const loadReports = useCallback(async () => {
    try {
      const response = await respondentListGradingReports({
        page: reportsPage,
        limit: 20,
      })
      setReports(response.items)
      setReportsTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }, [reportsPage, toast, t])

  const loadData = useCallback(async () => {
    setLoading(true)
    await Promise.all([loadAnswers(), loadReports()])
    setLoading(false)
  }, [loadAnswers, loadReports])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    loadAnswers()
  }, [loadAnswers])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Button variant="ghost" onClick={() => router.push('/evaluation/respondent')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('actions.back')}
          </Button>
        </div>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('answers.history')}</h1>
        <p className="text-sm text-text-secondary">{t('respondent.my_answers_description')}</p>
      </div>

      <Tabs defaultValue="answers">
        <TabsList>
          <TabsTrigger value="answers">
            <FileText className="mr-2 h-4 w-4" />
            {t('answers.my_answers')} ({answersTotal})
          </TabsTrigger>
          <TabsTrigger value="reports">
            <CheckCircle className="mr-2 h-4 w-4" />
            {t('grading.my_reports')} ({reportsTotal})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="answers" className="mt-6">
          {loading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-6 w-1/2" />
                    <Skeleton className="h-4 w-3/4" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : answers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileText className="mx-auto mb-4 h-12 w-12 text-text-muted" />
                <h3 className="mb-2 text-lg font-medium">{t('answers.no_answers')}</h3>
                <p className="mb-4 text-sm text-text-secondary">{t('topics.browse_description')}</p>
                <Button variant="primary" onClick={() => router.push('/evaluation/respondent')}>
                  {t('topics.browse')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {answers.map(answer => (
                <Card key={answer.id} className="transition-shadow hover:shadow-md">
                  <CardContent className="p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-text-muted" />
                        <span className="text-sm text-text-secondary">
                          {new Date(answer.submitted_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        {answer.is_latest && <Badge variant="success">{t('answers.latest')}</Badge>}
                        <Badge variant="info">
                          {t('answers.version')}: {answer.question_version}
                        </Badge>
                      </div>
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap text-text-primary">
                      {typeof answer.content_data?.text === 'string'
                        ? answer.content_data.text
                        : ''}
                    </p>
                  </CardContent>
                </Card>
              ))}

              {/* Pagination */}
              {answersTotal > 20 && (
                <div className="mt-6 flex justify-center gap-2">
                  <Button
                    variant="outline"
                    disabled={answersPage === 1}
                    onClick={() => setAnswersPage(answersPage - 1)}
                  >
                    Previous
                  </Button>
                  <span className="flex items-center px-4 text-sm text-text-secondary">
                    Page {answersPage} of {Math.ceil(answersTotal / 20)}
                  </span>
                  <Button
                    variant="outline"
                    disabled={answersPage >= Math.ceil(answersTotal / 20)}
                    onClick={() => setAnswersPage(answersPage + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="reports" className="mt-6">
          {loading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-6 w-1/2" />
                    <Skeleton className="h-4 w-3/4" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : reports.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircle className="mx-auto mb-4 h-12 w-12 text-text-muted" />
                <h3 className="mb-2 text-lg font-medium">{t('grading.no_tasks')}</h3>
                <p className="text-sm text-text-secondary">
                  {t('respondent.my_reports_description')}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {reports.map(report => (
                <Card key={report.id} className="transition-shadow hover:shadow-md">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {report.question_title || `Question #${report.question_id}`}
                      </CardTitle>
                      <Badge variant="success">{getStatusLabel(report.status, 'grading')}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-2 flex items-center gap-4 text-sm text-text-secondary">
                      {report.published_at && (
                        <span>Published: {new Date(report.published_at).toLocaleString()}</span>
                      )}
                    </div>
                    {report.report_data && typeof report.report_data === 'object' && (
                      <div className="rounded-lg bg-surface p-4">
                        <h4 className="mb-2 font-medium">{t('grading.report')}</h4>
                        <p className="whitespace-pre-wrap text-sm text-text-secondary">
                          {typeof (report.report_data as Record<string, unknown>).content ===
                          'string'
                            ? String((report.report_data as Record<string, unknown>).content)
                            : JSON.stringify(report.report_data, null, 2)}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}

              {/* Pagination */}
              {reportsTotal > 20 && (
                <div className="mt-6 flex justify-center gap-2">
                  <Button
                    variant="outline"
                    disabled={reportsPage === 1}
                    onClick={() => setReportsPage(reportsPage - 1)}
                  >
                    Previous
                  </Button>
                  <span className="flex items-center px-4 text-sm text-text-secondary">
                    Page {reportsPage} of {Math.ceil(reportsTotal / 20)}
                  </span>
                  <Button
                    variant="outline"
                    disabled={reportsPage >= Math.ceil(reportsTotal / 20)}
                    onClick={() => setReportsPage(reportsPage + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function RespondentHistoryPage() {
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
        <RespondentHistoryContent />
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
          <RespondentHistoryContent />
        </main>
      </div>
    </div>
  )
}
