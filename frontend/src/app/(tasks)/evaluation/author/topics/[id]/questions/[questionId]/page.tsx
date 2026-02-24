// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Edit, Trash2, Send, X, Check, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import {
  getAuthorQuestion,
  updateAuthorQuestion,
  deleteAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import { ContentType, QuestionStatus, type Question, type EvalAttachment } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function QuestionDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.questionId as string)

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [activeTab, setActiveTab] = useState('content')

  // Form state - support both text and attachments
  const [title, setTitle] = useState('')
  const [contentText, setContentText] = useState('')
  const [contentAttachments, setContentAttachments] = useState<EvalAttachment[]>([])
  const [showContentPreview, setShowContentPreview] = useState(false)
  const [criteriaText, setCriteriaText] = useState('')
  const [criteriaAttachments, setCriteriaAttachments] = useState<EvalAttachment[]>([])
  const [showCriteriaPreview, setShowCriteriaPreview] = useState(false)

  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const questionData = await getAuthorQuestion(questionId)
      setQuestion(questionData)
      // Populate form fields
      setTitle(questionData.title)
      setContentText((questionData.content_data?.text as string) || '')
      setContentAttachments((questionData.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaText((questionData.criteria_data?.text as string) || '')
      setCriteriaAttachments((questionData.criteria_data?.attachments as EvalAttachment[]) || [])
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push(`/evaluation/author/topics/${topicId}`)
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, router, t])

  useEffect(() => {
    if (questionId) {
      loadQuestion()
    }
  }, [questionId, loadQuestion])

  const handleCancelEdit = () => {
    if (question) {
      // Reset form to original values
      setTitle(question.title)
      setContentText((question.content_data?.text as string) || '')
      setContentAttachments((question.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaText((question.criteria_data?.text as string) || '')
      setCriteriaAttachments((question.criteria_data?.attachments as EvalAttachment[]) || [])
    }
    setIsEditing(false)
    setShowContentPreview(false)
    setShowCriteriaPreview(false)
  }

  const handleSave = async () => {
    if (!title.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.question_title') + ' is required',
        variant: 'destructive',
      })
      return
    }

    const hasContent = contentText.trim().length > 0 || contentAttachments.length > 0
    if (!hasContent) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.content') + ' is required',
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      // Build content_data - use MIXED type if has both text and attachments
      const contentData: Record<string, unknown> = {}
      if (contentText.trim()) {
        contentData.text = contentText.trim()
      }
      if (contentAttachments.length > 0) {
        contentData.attachments = contentAttachments
      }

      // Build criteria_data - use MIXED type if has both text and attachments
      const criteriaData: Record<string, unknown> = {}
      if (criteriaText.trim()) {
        criteriaData.text = criteriaText.trim()
      }
      if (criteriaAttachments.length > 0) {
        criteriaData.attachments = criteriaAttachments
      }

      await updateAuthorQuestion(questionId, {
        title: title.trim(),
        content_type: ContentType.MIXED,
        content_data: contentData,
        criteria_type: ContentType.MIXED,
        criteria_data: Object.keys(criteriaData).length > 0 ? criteriaData : undefined,
      })

      toast({
        title: t('questions.updated_success'),
        description: '',
      })
      setIsEditing(false)
      setShowContentPreview(false)
      setShowCriteriaPreview(false)
      loadQuestion()
    } catch (error) {
      toast({
        title: t('errors.save_failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handlePublish = async () => {
    setPublishing(true)
    try {
      await publishAuthorQuestion(questionId)
      toast({
        title: t('questions.published_success'),
        description: '',
      })
      loadQuestion()
    } catch (error) {
      toast({
        title: t('errors.save_failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteAuthorQuestion(questionId)
      toast({
        title: t('questions.deleted_success'),
        description: '',
      })
      router.push(`/evaluation/author/topics/${topicId}`)
    } catch (error) {
      toast({
        title: t('errors.delete_failed'),
        description: error instanceof Error ? error.message : t('errors.delete_failed'),
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  // Helper function to get status label with i18n
  const getStatusText = (status: number) => {
    if (status === QuestionStatus.DRAFT) {
      return t('common.draft')
    }
    return t('topics.published')
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="mt-2 h-4 w-1/4" />
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!question) {
    return null
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex gap-2">
          {!isEditing && (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <Edit className="mr-2 h-4 w-4" />
                {t('actions.edit')}
              </Button>
              {question.status === QuestionStatus.DRAFT && (
                <Button variant="primary" onClick={handlePublish} disabled={publishing}>
                  <Send className="mr-2 h-4 w-4" />
                  {publishing ? '...' : t('questions.publish')}
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('actions.delete')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('questions.delete_title')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('questions.delete_description')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleting}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {deleting ? '...' : t('actions.confirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {isEditing && (
            <>
              <Button variant="outline" onClick={handleCancelEdit}>
                <X className="mr-2 h-4 w-4" />
                {t('actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                <Check className="mr-2 h-4 w-4" />
                {saving ? '...' : t('actions.save')}
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{isEditing ? t('questions.edit') : question.title}</CardTitle>
            <Badge variant={question.status === QuestionStatus.PUBLISHED ? 'success' : 'info'}>
              {getStatusText(question.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <div className="space-y-6">
              {/* Title */}
              <div className="space-y-2">
                <Label htmlFor="title">{t('questions.question_title')} *</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={t('questions.title_placeholder')}
                  maxLength={500}
                />
              </div>

              {/* Tabs for editing */}
              <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="content">{t('questions.content')}</TabsTrigger>
                  <TabsTrigger value="criteria">{t('questions.criteria')}</TabsTrigger>
                </TabsList>

                {/* Content Tab */}
                <TabsContent value="content" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="contentText">{t('questions.content')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowContentPreview(!showContentPreview)}
                      >
                        {showContentPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('actions.edit')}
                          </>
                        ) : (
                          <>
                            <Eye className="mr-1 h-4 w-4" />
                            {t('questions.preview', 'Preview')}
                          </>
                        )}
                      </Button>
                    </div>
                    {showContentPreview ? (
                      <div className="min-h-[200px] rounded-lg border border-border bg-surface p-4">
                        {contentText.trim() ? (
                          <EnhancedMarkdown
                            source={contentText}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        ) : (
                          <p className="text-text-muted">{t('questions.no_content')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="contentText"
                        value={contentText}
                        onChange={e => setContentText(e.target.value)}
                        placeholder={t('questions.content_placeholder')}
                        rows={10}
                        className="font-mono text-sm"
                      />
                    )}
                    <p className="text-xs text-text-muted">
                      {t('questions.markdown_hint', 'Supports Markdown formatting: **bold**, *italic*, `code`, lists, etc.')}
                    </p>
                  </div>

                  {/* Content Attachments */}
                  <div className="space-y-2">
                    <Label>{t('questions.content_attachments')}</Label>
                    <EvaluationFileUpload
                      topicId={topicId}
                      questionId={questionId}
                      fileType="question_content"
                      attachments={contentAttachments}
                      onChange={setContentAttachments}
                      maxFiles={10}
                    />
                  </div>
                </TabsContent>

                {/* Criteria Tab */}
                <TabsContent value="criteria" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="criteriaText">{t('questions.criteria')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowCriteriaPreview(!showCriteriaPreview)}
                      >
                        {showCriteriaPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('actions.edit')}
                          </>
                        ) : (
                          <>
                            <Eye className="mr-1 h-4 w-4" />
                            {t('questions.preview', 'Preview')}
                          </>
                        )}
                      </Button>
                    </div>
                    {showCriteriaPreview ? (
                      <div className="min-h-[150px] rounded-lg border border-primary/20 bg-primary/5 p-4">
                        {criteriaText.trim() ? (
                          <EnhancedMarkdown
                            source={criteriaText}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        ) : (
                          <p className="text-text-muted">{t('questions.no_criteria')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="criteriaText"
                        value={criteriaText}
                        onChange={e => setCriteriaText(e.target.value)}
                        placeholder={t('questions.criteria_placeholder')}
                        rows={6}
                        className="font-mono text-sm"
                      />
                    )}
                    <p className="text-xs text-text-muted">{t('grading.description')}</p>
                  </div>

                  {/* Criteria Attachments */}
                  <div className="space-y-2">
                    <Label>{t('questions.criteria_attachments')}</Label>
                    <EvaluationFileUpload
                      topicId={topicId}
                      questionId={questionId}
                      fileType="question_criteria"
                      attachments={criteriaAttachments}
                      onChange={setCriteriaAttachments}
                      maxFiles={10}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Display mode - Content (Markdown rendered) */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.content')}</Label>
                {typeof question.content_data?.text === 'string' && question.content_data.text ? (
                  <div className="rounded-lg border border-border bg-surface p-4">
                    <EnhancedMarkdown
                      source={question.content_data.text}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-text-muted">{t('questions.no_content')}</p>
                )}
                {/* Content attachments */}
                {question.content_data?.attachments && question.content_data.attachments.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <Label>{t('questions.content_attachments')}</Label>
                    <div className="space-y-2">
                      {(question.content_data.attachments as EvalAttachment[]).map((attachment, index) => (
                        <div
                          key={attachment.key || index}
                          className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
                        >
                          <div className="flex items-center gap-2">
                            <div className="h-10 w-10 rounded bg-primary/10 flex items-center justify-center">
                              <span className="text-xs font-medium text-primary">
                                {attachment.filename.split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE'}
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-medium">{attachment.filename}</p>
                              {attachment.file_size && (
                                <p className="text-xs text-text-muted">
                                  {(attachment.file_size / 1024).toFixed(1)} KB
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Display mode - Criteria (Markdown rendered) */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.criteria')}</Label>
                {typeof question.criteria_data?.text === 'string' && question.criteria_data.text ? (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <EnhancedMarkdown
                      source={question.criteria_data.text}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-text-muted">{t('questions.no_criteria')}</p>
                )}
                {/* Criteria attachments */}
                {question.criteria_data?.attachments && question.criteria_data.attachments.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <Label>{t('questions.criteria_attachments')}</Label>
                    <div className="space-y-2">
                      {(question.criteria_data.attachments as EvalAttachment[]).map((attachment, index) => (
                        <div
                          key={attachment.key || index}
                          className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
                        >
                          <div className="flex items-center gap-2">
                            <div className="h-10 w-10 rounded bg-primary/10 flex items-center justify-center">
                              <span className="text-xs font-medium text-primary">
                                {attachment.filename.split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE'}
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-medium">{attachment.filename}</p>
                              {attachment.file_size && (
                                <p className="text-xs text-text-muted">
                                  {(attachment.file_size / 1024).toFixed(1)} KB
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Metadata */}
              <div className="border-t pt-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-text-secondary">Version:</span>{' '}
                    <span className="text-text-primary">{question.current_version || '-'}</span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Order:</span>{' '}
                    <span className="text-text-primary">{question.order_index}</span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Created:</span>{' '}
                    <span className="text-text-primary">
                      {new Date(question.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Updated:</span>{' '}
                    <span className="text-text-primary">
                      {new Date(question.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function QuestionDetailPage() {
  return (
    <EvaluationPageLayout>
      <QuestionDetailContent />
    </EvaluationPageLayout>
  )
}