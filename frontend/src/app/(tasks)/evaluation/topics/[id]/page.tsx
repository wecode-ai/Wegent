// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Edit,
  Trash2,
  Plus,
  Users,
  FileCheck,
  BarChart3,
  Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  getTopic,
  deleteTopic,
  publishTopic,
  getTopicStatistics,
  listQuestions,
  getMyRole,
} from '@wecode/api/evaluation'
import type {
  Topic,
  Question,
  TopicStatistics,
  UserRole,
} from '@wecode/types/evaluation'
import {
  TopicStatus,
  TopicVisibility,
  QuestionStatus,
  getStatusLabel,
  getVisibilityLabel,
} from '@wecode/types/evaluation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function TopicDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [statistics, setStatistics] = useState<TopicStatistics | null>(null)
  const [userRole, setUserRole] = useState<UserRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, questionsData, roleData] = await Promise.all([
        getTopic(topicId),
        listQuestions(topicId, { limit: 100 }),
        getMyRole(topicId),
      ])
      setTopic(topicData)
      setQuestions(questionsData.items)
      setUserRole(roleData)

      // Load statistics if user can view them
      if (roleData.can_grade || roleData.can_edit) {
        const statsData = await getTopicStatistics(topicId)
        setStatistics(statsData)
      }
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load topic',
        variant: 'destructive',
      })
      router.push('/evaluation/topics')
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

  const handlePublish = async () => {
    setPublishing(true)
    try {
      await publishTopic(topicId)
      toast({
        title: 'Success',
        description: 'Topic published successfully',
      })
      loadData()
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to publish topic',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteTopic(topicId)
      toast({
        title: 'Success',
        description: 'Topic deleted successfully',
      })
      router.push('/evaluation/topics')
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to delete topic',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="mb-8 h-4 w-3/4" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    )
  }

  if (!topic) {
    return null
  }

  const publishedQuestions = questions.filter(
    (q) => q.status === QuestionStatus.PUBLISHED
  )

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/topics')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Topics
        </Button>
        {userRole?.can_edit && (
          <div className="flex gap-2">
            <Link href={`/evaluation/topics/${topicId}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </Link>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Topic</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this topic? This action
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Topic Info */}
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-primary">{topic.name}</h1>
          <Badge
            variant={
              topic.visibility === TopicVisibility.PUBLIC ? 'default' : 'secondary'
            }
          >
            {getVisibilityLabel(topic.visibility)}
          </Badge>
          <Badge
            variant={topic.status === TopicStatus.PUBLISHED ? 'success' : 'info'}
          >
            {getStatusLabel(topic.status, 'topic')}
          </Badge>
        </div>
        {topic.description && (
          <p className="mb-4 text-text-secondary">{topic.description}</p>
        )}
        {userRole?.can_edit && publishedQuestions.length > 0 && (
          <Button variant="primary" onClick={handlePublish} disabled={publishing}>
            <Send className="mr-2 h-4 w-4" />
            {publishing ? 'Publishing...' : 'Publish Topic'}
          </Button>
        )}
      </div>

      {/* Statistics */}
      {statistics && (
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">Questions</div>
              <div className="text-2xl font-semibold">
                {statistics.published_questions} / {statistics.total_questions}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">Respondents</div>
              <div className="text-2xl font-semibold">
                {statistics.total_respondents}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">Answers</div>
              <div className="text-2xl font-semibold">{statistics.total_answers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-text-secondary">Grading</div>
              <div className="text-2xl font-semibold">
                {statistics.grading_published} / {statistics.grading_completed}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="questions">
        <TabsList>
          <TabsTrigger value="questions">
            <FileCheck className="mr-2 h-4 w-4" />
            Questions ({questions.length})
          </TabsTrigger>
          {userRole?.can_edit && (
            <TabsTrigger value="permissions">
              <Users className="mr-2 h-4 w-4" />
              Permissions
            </TabsTrigger>
          )}
          {userRole?.can_grade && (
            <TabsTrigger value="grading">
              <BarChart3 className="mr-2 h-4 w-4" />
              Grading
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="questions" className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium">Questions</h2>
            {userRole?.can_edit && (
              <Link href={`/evaluation/topics/${topicId}/questions/new`}>
                <Button variant="outline">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Question
                </Button>
              </Link>
            )}
          </div>

          {questions.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-text-secondary">No questions yet</p>
                {userRole?.can_edit && (
                  <Link href={`/evaluation/topics/${topicId}/questions/new`}>
                    <Button variant="outline" className="mt-4">
                      <Plus className="mr-2 h-4 w-4" />
                      Create First Question
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {questions.map((question, index) => (
                <Card
                  key={question.id}
                  className="cursor-pointer transition-shadow hover:shadow-md"
                  onClick={() =>
                    router.push(
                      `/evaluation/topics/${topicId}/questions/${question.id}`
                    )
                  }
                >
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-sm font-medium">
                        {index + 1}
                      </span>
                      <div>
                        <h3 className="font-medium">{question.title}</h3>
                        <span className="text-xs text-text-muted">
                          {question.content_type}
                        </span>
                      </div>
                    </div>
                    <Badge
                      variant={
                        question.status === QuestionStatus.PUBLISHED
                          ? 'success'
                          : 'info'
                      }
                    >
                      {getStatusLabel(question.status, 'question')}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="permissions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Permission Management</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-text-secondary">
                Permission management will be available here.
              </p>
              <Link href={`/evaluation/topics/${topicId}/permissions`}>
                <Button variant="outline" className="mt-4">
                  <Users className="mr-2 h-4 w-4" />
                  Manage Permissions
                </Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="grading" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Grading Tasks</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-text-secondary">
                Grading task management will be available here.
              </p>
              <Link href={`/evaluation/topics/${topicId}/grading`}>
                <Button variant="outline" className="mt-4">
                  <BarChart3 className="mr-2 h-4 w-4" />
                  View Grading Tasks
                </Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function TopicDetailPage() {
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
        <TopicDetailContent />
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
          <TopicDetailContent />
        </main>
      </div>
    </div>
  )
}
