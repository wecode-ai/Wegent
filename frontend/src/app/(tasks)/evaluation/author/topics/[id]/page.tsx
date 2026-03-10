// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getAuthorTopic,
  getAuthorTopicStatistics,
  listAuthorQuestions,
} from '@wecode/api/evaluation-author'
import type { Topic, Question, TopicStatistics } from '@wecode/types/evaluation'

// Import components from wecode package
import {
  TopicHeader,
  TopicStats,
  QuestionsTab,
  PermissionsTab,
  VersionsTab,
  ExamSessionsTab,
  GradingConfigTab,
  ConfigDrawer,
} from '@wecode/components/evaluation/author'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileQuestion, Users, Settings, History, GraduationCap } from 'lucide-react'

// Available tabs
const TAB_VALUES = ['questions', 'permissions', 'grading', 'versions', 'exam-sessions'] as const
type TabValue = (typeof TAB_VALUES)[number]

/**
 * Author Topic Detail Page (Unified)
 *
 * This is the redesigned unified page that consolidates all topic management
 * functionality (config, permissions, grading-config, versions, exam-sessions)
 * into a single page with a modern, clean layout.
 *
 * Design:
 * - Soft gray background (#fafbfc)
 * - White rounded cards (rounded-2xl or rounded-3xl)
 * - Red accent color (#DF2029) for primary actions
 * - Sticky header with backdrop blur
 * - Single-column layout for clean presentation
 * - Responsive: adapts to all screen sizes
 */
function TopicDetailContent() {
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  // Data state
  const [topic, setTopic] = useState<Topic | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [statistics, setStatistics] = useState<TopicStatistics | null>(null)
  const [loading, setLoading] = useState(true)

  // Drawer state
  const [isConfigDrawerOpen, setIsConfigDrawerOpen] = useState(false)

  // Active tab state - read from URL or default to 'questions'
  const activeTab: TabValue = useMemo(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam && TAB_VALUES.includes(tabParam as TabValue)) {
      return tabParam as TabValue
    }
    return 'questions'
  }, [searchParams])

  // Handle tab change - update URL
  const handleTabChange = useCallback(
    (newTab: string) => {
      const params = new URLSearchParams(searchParams)
      if (newTab === 'questions') {
        params.delete('tab')
      } else {
        params.set('tab', newTab)
      }
      const newUrl = `/evaluation/author/topics/${topicId}${params.toString() ? `?${params.toString()}` : ''}`
      router.push(newUrl, { scroll: false })
    },
    [router, searchParams, topicId]
  )

  // Load topic data
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, questionsData, statsData] = await Promise.all([
        getAuthorTopic(topicId),
        listAuthorQuestions(topicId, { limit: 100 }),
        getAuthorTopicStatistics(topicId),
      ])
      setTopic(topicData)
      setQuestions(questionsData.items)
      setStatistics(statsData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/author')
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

  // Handle back navigation
  const handleBack = () => {
    router.push('/evaluation/author')
  }

  // Handle edit configuration - opens config drawer
  const handleEditConfig = () => {
    setIsConfigDrawerOpen(true)
  }

  // Handle drawer close
  const handleConfigDrawerClose = () => {
    setIsConfigDrawerOpen(false)
  }

  // Handle topic update from drawer
  const handleTopicUpdateFromDrawer = useCallback((updatedTopic: Topic) => {
    setTopic(updatedTopic)
  }, [])

  // Handle questions change (reorder, delete, publish)
  const handleQuestionsChange = useCallback((newQuestions: Question[]) => {
    setQuestions(newQuestions)
  }, [])

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        {/* Skeleton header */}
        <div className="bg-white/95 backdrop-blur-md border-b border-gray-100">
          <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-9 w-32" />
            </div>
          </div>
        </div>

        {/* Skeleton content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
          <div className="space-y-6">
            <Skeleton className="h-48 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-48 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    )
  }

  // Error state - topic not found
  if (!topic) {
    return null
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Sticky Header */}
      <TopicHeader
        topic={topic}
        onBack={handleBack}
        onEditConfig={handleEditConfig}
        isLoading={loading}
      />

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
        <div className="space-y-6">
          {/* Statistics Overview */}
          <TopicStats statistics={statistics} isLoading={loading} />

          {/* Tabs Section */}
          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <TabsList className="w-full justify-start bg-white border border-gray-100 rounded-xl p-1 h-auto flex-wrap gap-1">
              <TabsTrigger
                value="questions"
                className="flex items-center gap-2 px-4 py-2.5 data-[state=active]:bg-gray-50 data-[state=active]:shadow-sm"
              >
                <FileQuestion className="w-4 h-4" />
                <span className="hidden sm:inline">{t('questions.title')}</span>
                <span className="sm:hidden">Questions</span>
              </TabsTrigger>
              <TabsTrigger
                value="permissions"
                className="flex items-center gap-2 px-4 py-2.5 data-[state=active]:bg-gray-50 data-[state=active]:shadow-sm"
              >
                <Users className="w-4 h-4" />
                <span className="hidden sm:inline">{t('permissions.title')}</span>
                <span className="sm:hidden">Permissions</span>
              </TabsTrigger>
              <TabsTrigger
                value="grading"
                className="flex items-center gap-2 px-4 py-2.5 data-[state=active]:bg-gray-50 data-[state=active]:shadow-sm"
              >
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">{t('grading.title')}</span>
                <span className="sm:hidden">Grading</span>
              </TabsTrigger>
              <TabsTrigger
                value="versions"
                className="flex items-center gap-2 px-4 py-2.5 data-[state=active]:bg-gray-50 data-[state=active]:shadow-sm"
              >
                <History className="w-4 h-4" />
                <span className="hidden sm:inline">{t('topics.versions')}</span>
                <span className="sm:hidden">Versions</span>
              </TabsTrigger>
              <TabsTrigger
                value="exam-sessions"
                className="flex items-center gap-2 px-4 py-2.5 data-[state=active]:bg-gray-50 data-[state=active]:shadow-sm"
              >
                <GraduationCap className="w-4 h-4" />
                <span className="hidden sm:inline">{t('exam_sessions.title')}</span>
                <span className="sm:hidden">{t('exam_sessions.title')}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="questions" className="mt-6">
              <QuestionsTab
                topicId={topicId}
                questions={questions}
                isLoading={loading}
                onQuestionsChange={handleQuestionsChange}
              />
            </TabsContent>

            <TabsContent value="permissions" className="mt-6">
              <PermissionsTab topicId={topicId} />
            </TabsContent>

            <TabsContent value="grading" className="mt-6">
              <GradingConfigTab topicId={topicId} statistics={statistics} />
            </TabsContent>

            <TabsContent value="versions" className="mt-6">
              <VersionsTab topicId={topicId} currentVersion={topic.current_version} />
            </TabsContent>

            <TabsContent value="exam-sessions" className="mt-6">
              <ExamSessionsTab topicId={topicId} />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      {/* Config Drawer */}
      <ConfigDrawer
        isOpen={isConfigDrawerOpen}
        topicId={topicId}
        onClose={handleConfigDrawerClose}
        onTopicUpdate={handleTopicUpdateFromDrawer}
      />
    </div>
  )
}

export default function TopicDetailPage() {
  return (
    <EvaluationPageLayout>
      <TopicDetailContent />
    </EvaluationPageLayout>
  )
}
