// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Send, Edit, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  getQuestion,
  updateQuestion,
  deleteQuestion,
  publishQuestion,
  getMyRole,
  submitAnswer,
  listMyAnswers,
} from '@wecode/api/evaluation'
import {
  type Question,
  type UserRole,
  type Answer,
  QuestionStatus,
  ContentType,
  getStatusLabel,
} from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function QuestionDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [question, setQuestion] = useState<Question | null>(null)
  const [userRole, setUserRole] = useState<UserRole | null>(null)
  const [myAnswers, setMyAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  // Edit form state
  const [editTitle, setEditTitle] = useState('')
  const [editContentType, setEditContentType] = useState<string>(ContentType.TEXT)
  const [editContentText, setEditContentText] = useState('')
  const [editContentUrl, setEditContentUrl] = useState('')
  const [editCriteriaText, setEditCriteriaText] = useState('')

  // Answer form state
  const [answerText, setAnswerText] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [questionData, roleData] = await Promise.all([
        getQuestion(questionId),
        getMyRole(topicId),
      ])
      setQuestion(questionData)
      setUserRole(roleData)

      // Initialize edit form
      setEditTitle(questionData.title)
      setEditContentType(questionData.content_type)
      setEditContentText(
        typeof questionData.content_data?.text === 'string' ? questionData.content_data.text : ''
      )
      setEditContentUrl(
        typeof questionData.content_data?.url === 'string' ? questionData.content_data.url : ''
      )
      setEditCriteriaText(
        typeof questionData.criteria_data?.text === 'string' ? questionData.criteria_data.text : ''
      )

      // Load my answers if respondent
      if (roleData.can_answer) {
        const answersData = await listMyAnswers(questionId)
        setMyAnswers(answersData.items)
      }
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push(`/evaluation/topics/${topicId}`)
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, router, t])

  useEffect(() => {
    if (questionId && topicId) {
      loadData()
    }
  }, [questionId, topicId, loadData])

  const handlePublish = async () => {
    setPublishing(true)
    try {
      await publishQuestion(questionId)
      toast({
        title: t('questions.published_success'),
        description: '',
      })
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteQuestion(questionId)
      toast({
        title: t('questions.deleted_success'),
        description: '',
      })
      router.push(`/evaluation/topics/${topicId}`)
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleSaveEdit = async () => {
    setSubmitting(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (editContentType === ContentType.TEXT || editContentType === ContentType.MIXED) {
        contentData.text = editContentText.trim()
      }
      if (editContentType === ContentType.URL || editContentType === ContentType.MIXED) {
        contentData.url = editContentUrl.trim()
      }

      const criteriaData: Record<string, unknown> = {}
      if (editCriteriaText.trim()) {
        criteriaData.text = editCriteriaText.trim()
      }

      await updateQuestion(questionId, {
        title: editTitle.trim(),
        content_type: editContentType,
        content_data: contentData,
        criteria_data: Object.keys(criteriaData).length > 0 ? criteriaData : undefined,
      })

      toast({
        title: t('questions.updated_success'),
        description: '',
      })
      setIsEditing(false)
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitAnswer = async () => {
    if (!answerText.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('answers.content') + ' is required',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      await submitAnswer(questionId, {
        content_type: 'text',
        content_text: answerText.trim(),
      })

      toast({
        title: t('answers.submit_success'),
        description: '',
      })
      setAnswerText('')
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="mb-8 h-32 w-full" />
      </div>
    )
  }

  if (!question) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push(`/evaluation/topics/${topicId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        {userRole?.can_edit && (
          <div className="flex gap-2">
            {question.status === QuestionStatus.DRAFT && (
              <Button variant="primary" onClick={handlePublish} disabled={publishing}>
                <Send className="mr-2 h-4 w-4" />
                {publishing ? '...' : t('questions.publish')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setIsEditing(!isEditing)}>
              <Edit className="mr-2 h-4 w-4" />
              {t('questions.edit')}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('questions.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('questions.delete')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('questions.confirm_delete')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? '...' : t('actions.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Question Info or Edit Form */}
      {isEditing ? (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{t('questions.edit')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="editTitle">{t('questions.question_title')} *</Label>
              <Input
                id="editTitle"
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="editContentType">{t('questions.content_type')}</Label>
              <Select value={editContentType} onValueChange={setEditContentType}>
                <SelectTrigger id="editContentType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t('questions.content_types.text')}</SelectItem>
                  <SelectItem value="url">{t('questions.content_types.url')}</SelectItem>
                  <SelectItem value="attachment">
                    {t('questions.content_types.attachment')}
                  </SelectItem>
                  <SelectItem value="mixed">{t('questions.content_types.mixed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(editContentType === ContentType.TEXT || editContentType === ContentType.MIXED) && (
              <div className="space-y-2">
                <Label htmlFor="editContentText">{t('questions.content')}</Label>
                <Textarea
                  id="editContentText"
                  value={editContentText}
                  onChange={e => setEditContentText(e.target.value)}
                  rows={6}
                />
              </div>
            )}

            {(editContentType === ContentType.URL || editContentType === ContentType.MIXED) && (
              <div className="space-y-2">
                <Label htmlFor="editContentUrl">URL</Label>
                <Input
                  id="editContentUrl"
                  type="url"
                  value={editContentUrl}
                  onChange={e => setEditContentUrl(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="editCriteria">{t('questions.criteria')}</Label>
              <Textarea
                id="editCriteria"
                value={editCriteriaText}
                onChange={e => setEditCriteriaText(e.target.value)}
                rows={4}
              />
            </div>

            <div className="flex justify-end gap-4">
              <Button variant="outline" onClick={() => setIsEditing(false)}>
                {t('actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleSaveEdit} disabled={submitting}>
                {submitting ? '...' : t('actions.save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-8">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{question.title}</CardTitle>
              <Badge variant={question.status === QuestionStatus.PUBLISHED ? 'success' : 'info'}>
                {getStatusLabel(question.status, 'question')}
              </Badge>
            </div>
            <CardDescription>
              {t('questions.content_type')}: {t(`questions.content_types.${question.content_type}`)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {typeof question.content_data?.text === 'string' && question.content_data.text && (
              <div>
                <h3 className="mb-2 font-medium">{t('questions.content')}</h3>
                <p className="whitespace-pre-wrap text-text-secondary">
                  {question.content_data.text}
                </p>
              </div>
            )}
            {typeof question.content_data?.url === 'string' && question.content_data.url && (
              <div>
                <h3 className="mb-2 font-medium">URL</h3>
                <a
                  href={question.content_data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {question.content_data.url}
                </a>
              </div>
            )}
            {typeof question.criteria_data?.text === 'string' && question.criteria_data.text && (
              <div>
                <h3 className="mb-2 font-medium">{t('questions.criteria')}</h3>
                <p className="whitespace-pre-wrap text-text-secondary">
                  {question.criteria_data.text}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Answer Section for respondents */}
      {userRole?.can_answer && question.status === QuestionStatus.PUBLISHED && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{t('answers.submit')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="answerText">{t('answers.content')}</Label>
              <Textarea
                id="answerText"
                value={answerText}
                onChange={e => setAnswerText(e.target.value)}
                placeholder={t('answers.content')}
                rows={6}
              />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={handleSubmitAnswer} disabled={submitting}>
                {submitting ? '...' : t('answers.submit')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* My Answers */}
      {myAnswers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('answers.history')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {myAnswers.map(answer => (
                <div key={answer.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm text-text-secondary">
                      {t('answers.submitted_at')}: {new Date(answer.submitted_at).toLocaleString()}
                    </span>
                    {answer.is_latest && <Badge variant="success">{t('answers.latest')}</Badge>}
                  </div>
                  <p className="whitespace-pre-wrap">
                    {typeof answer.content_data?.text === 'string' ? answer.content_data.text : ''}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default function QuestionDetailPage() {
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
        <QuestionDetailContent />
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
          <QuestionDetailContent />
        </main>
      </div>
    </div>
  )
}
