// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ClipboardCheck,
  Plus,
  BookOpen,
  Users,
  BarChart3,
  PenTool,
  FileText,
  Award,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function EvaluationContent() {
  const router = useRouter()
  const { t } = useTranslation('evaluation')

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
          <ClipboardCheck className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">
            {t('title', 'AI Evaluation')}
          </h1>
          <p className="text-sm text-text-secondary">
            {t('description', 'Create and manage evaluation topics for AI-assisted grading')}
          </p>
        </div>
      </div>

      {/* Role-based Tabs */}
      <Tabs defaultValue="creator" className="w-full">
        <TabsList className="mb-6 grid w-full grid-cols-3">
          <TabsTrigger value="creator" className="flex items-center gap-2">
            <PenTool className="h-4 w-4" />
            {t('roles.creator', '出题人')}
          </TabsTrigger>
          <TabsTrigger value="respondent" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {t('roles.respondent', '答题人')}
          </TabsTrigger>
          <TabsTrigger value="grader" className="flex items-center gap-2">
            <Award className="h-4 w-4" />
            {t('roles.grader', '评分人')}
          </TabsTrigger>
        </TabsList>

        {/* Creator Tab */}
        <TabsContent value="creator">
          <div className="grid gap-6 md:grid-cols-2">
            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics/new')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Plus className="h-5 w-5 text-primary" />
                  {t('topics.create', 'Create Topic')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('topics.create_description', 'Create a new evaluation topic with questions and grading criteria.')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=creator')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-primary" />
                  {t('creator.my_topics', '我的专题')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('creator.my_topics_description', '管理您创建的考评专题，编辑题目和设置。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=creator&tab=permissions')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  {t('permissions.title', 'Permissions')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('permissions.description', 'Manage who can view, answer, and grade your topics.')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=creator&tab=statistics')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  {t('creator.statistics', '统计数据')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('creator.statistics_description', '查看答题人数、完成率等统计信息。')}
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Respondent Tab */}
        <TabsContent value="respondent">
          <div className="grid gap-6 md:grid-cols-2">
            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=respondent')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-primary" />
                  {t('topics.browse', 'Browse Topics')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('topics.browse_description', 'View and search evaluation topics, answer questions, and check your results.')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=respondent&tab=answers')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  {t('answers.my_answers', 'My Answers')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('respondent.my_answers_description', '查看您的作答历史和提交记录。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=respondent&tab=reports')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Award className="h-5 w-5 text-primary" />
                  {t('grading.my_reports', 'My Reports')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('respondent.my_reports_description', '查看您收到的评分报告和反馈。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=respondent&tab=progress')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  {t('answers.progress.title', 'My Progress')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('respondent.progress_description', '查看您的答题进度和完成情况。')}
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Grader Tab */}
        <TabsContent value="grader">
          <div className="grid gap-6 md:grid-cols-2">
            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=grader')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-primary" />
                  {t('grading.tasks', 'Grading Tasks')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('grader.tasks_description', '查看待评分的任务列表，执行 AI 辅助评分。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=grader&status=pending')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  {t('grader.pending_tasks', '待处理任务')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('grader.pending_tasks_description', '查看需要您评分或审核的任务。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=grader&status=completed')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Award className="h-5 w-5 text-primary" />
                  {t('grader.completed_tasks', '已完成评分')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('grader.completed_tasks_description', '查看您已完成的评分任务和报告。')}
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => router.push('/evaluation/topics?role=grader&action=publish')}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  {t('grading.publish', 'Publish Report')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary">
                  {t('grader.publish_description', '发布评分报告，让答题人查看结果。')}
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function EvaluationPage() {
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
        <EvaluationContent />
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
          <EvaluationContent />
        </main>
      </div>
    </div>
  )
}
