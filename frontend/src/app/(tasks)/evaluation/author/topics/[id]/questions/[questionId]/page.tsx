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
import { QuestionFileUpload } from '@wecode/components/evaluation'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import {
  getAuthorQuestion,
  updateAuthorQuestion,
  deleteAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import {
  ContentType,
  QuestionStatus,
  type Question,
  type EvalAttachment,
} from '@wecode/types/evaluation'
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

  // Unified form state - Markdown fields only
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [criteria, setCriteria] = useState('')
  const [instructions, setInstructions] = useState('')
  // Separate attachment states for each slot
  const [contentAttachments, setContentAttachments] = useState<EvalAttachment[]>([])
  const [criteriaAttachments, setCriteriaAttachments] = useState<EvalAttachment[]>([])
  const [instructionsAttachments, setInstructionsAttachments] = useState<EvalAttachment[]>([])

  // Preview states
  const [showContentPreview, setShowContentPreview] = useState(false)
  const [showCriteriaPreview, setShowCriteriaPreview] = useState(false)
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)

  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const questionData = await getAuthorQuestion(questionId)
      setQuestion(questionData)
      // Populate form fields with unified Markdown fields
      setTitle(questionData.title)
      setContent(
        (questionData.content_data?.content as string) ||
          (questionData.content_data?.text as string) ||
          ''
      )
      setCriteria(
        (questionData.criteria_data?.criteria as string) ||
          (questionData.criteria_data?.text as string) ||
          ''
      )
      setInstructions((questionData.content_data?.instructions as string) || '')
      // Load separate attachment states for each slot
      setContentAttachments((questionData.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaAttachments((questionData.criteria_data?.attachments as EvalAttachment[]) || [])
      setInstructionsAttachments(
        (questionData.content_data?.instructionsAttachments as EvalAttachment[]) || []
      )
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
      setContent(
        (question.content_data?.content as string) || (question.content_data?.text as string) || ''
      )
      setCriteria(
        (question.criteria_data?.criteria as string) ||
          (question.criteria_data?.text as string) ||
          ''
      )
      setInstructions((question.content_data?.instructions as string) || '')
      // Reset separate attachment states
      setContentAttachments((question.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaAttachments((question.criteria_data?.attachments as EvalAttachment[]) || [])
      setInstructionsAttachments(
        (question.content_data?.instructionsAttachments as EvalAttachment[]) || []
      )
    }
    setIsEditing(false)
    setShowContentPreview(false)
    setShowCriteriaPreview(false)
    setShowInstructionsPreview(false)
  }

  const handleSave = async () => {
    if (!title.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.title_placeholder'),
        variant: 'destructive',
      })
      return
    }

    const hasContent =
      content.trim().length > 0 ||
      contentAttachments.length > 0 ||
      criteriaAttachments.length > 0 ||
      instructionsAttachments.length > 0
    if (!hasContent) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.content_placeholder'),
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      // Build simplified content_data with unified Markdown fields
      const contentData: Record<string, unknown> = {
        content: content.trim(),
      }

      if (instructions.trim()) {
        contentData.instructions = instructions.trim()
      }

      if (contentAttachments.length > 0) {
        contentData.attachments = contentAttachments
      }

      if (instructionsAttachments.length > 0) {
        contentData.instructionsAttachments = instructionsAttachments
      }

      // Build criteria_data with unified Markdown field
      const criteriaData: Record<string, unknown> = {}
      if (criteria.trim()) {
        criteriaData.criteria = criteria.trim()
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

  // Render attachment list for display mode
  const renderAttachmentList = (attachments: EvalAttachment[] | undefined, label: string) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="mt-4 space-y-2">
        <Label>{label}</Label>
        <div className="space-y-2">
          {attachments.map((attachment, index) => (
            <div
              key={attachment.key || index}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded bg-primary/10">
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
    )
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
        <Button variant="ghost" onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex gap-2">
          {!isEditing && (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <Edit className="mr-2 h-4 w-4" />
                {t('common:actions.edit')}
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
                    {t('common:actions.delete')}
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
                    <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      disabled={deleting}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {deleting ? '...' : t('common:actions.confirm')}
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
                {t('common:actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                <Check className="mr-2 h-4 w-4" />
                {saving ? '...' : t('common:actions.save')}
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
                <p className="text-right text-xs text-text-muted">{title.length}/500</p>
              </div>

              <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="content">{t('questions.content')}</TabsTrigger>
                  <TabsTrigger value="criteria">{t('questions.criteria')}</TabsTrigger>
                  <TabsTrigger value="instructions">{t('questions.instructions')}</TabsTrigger>
                  <TabsTrigger value="attachments">
                    {t('questions.attachments', 'Attachments')}
                  </TabsTrigger>
                </TabsList>

                {/* Content Tab */}
                <TabsContent value="content" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="content">{t('questions.content')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowContentPreview(!showContentPreview)}
                      >
                        {showContentPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('common:actions.edit')}
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
                        {content.trim() ? (
                          <EnhancedMarkdown
                            source={content}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        ) : (
                          <p className="text-text-muted">{t('questions.no_content')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="content"
                        value={content}
                        onChange={e => setContent(e.target.value)}
                        placeholder={t('questions.content_placeholder')}
                        rows={10}
                        className="font-mono text-sm"
                      />
                    )}
                    <p className="text-xs text-text-muted">
                      {t(
                        'questions.markdown_hint',
                        'Supports Markdown formatting: **bold**, *italic*, `code`, lists, etc.'
                      )}
                    </p>
                  </div>
                </TabsContent>

                {/* Criteria Tab */}
                <TabsContent value="criteria" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="criteria">{t('questions.criteria')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowCriteriaPreview(!showCriteriaPreview)}
                      >
                        {showCriteriaPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('common:actions.edit')}
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
                        {criteria.trim() ? (
                          <EnhancedMarkdown
                            source={criteria}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        ) : (
                          <p className="text-text-muted">{t('questions.no_criteria')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="criteria"
                        value={criteria}
                        onChange={e => setCriteria(e.target.value)}
                        placeholder={t('questions.criteria_placeholder')}
                        rows={6}
                        className="font-mono text-sm"
                      />
                    )}
                    <p className="text-xs text-text-muted">{t('questions.criteria_placeholder')}</p>
                  </div>
                </TabsContent>

                {/* Instructions Tab */}
                <TabsContent value="instructions" className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="instructions">{t('questions.instructions')} (Markdown)</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowInstructionsPreview(!showInstructionsPreview)}
                      >
                        {showInstructionsPreview ? (
                          <>
                            <EyeOff className="mr-1 h-4 w-4" />
                            {t('common:actions.edit')}
                          </>
                        ) : (
                          <>
                            <Eye className="mr-1 h-4 w-4" />
                            {t('questions.preview', 'Preview')}
                          </>
                        )}
                      </Button>
                    </div>
                    {showInstructionsPreview ? (
                      <div className="min-h-[150px] rounded-lg border border-border bg-surface p-4">
                        {instructions.trim() ? (
                          <EnhancedMarkdown
                            source={instructions}
                            theme={theme === 'dark' ? 'dark' : 'light'}
                          />
                        ) : (
                          <p className="text-text-muted">{t('topics.no_instructions')}</p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        id="instructions"
                        value={instructions}
                        onChange={e => setInstructions(e.target.value)}
                        placeholder={t('questions.instructions_placeholder')}
                        rows={8}
                        className="font-mono text-sm"
                      />
                    )}
                    <p className="text-xs text-text-muted">{t('questions.instructions_hint')}</p>
                  </div>
                </TabsContent>

                {/* Attachments Tab */}
                <TabsContent value="attachments" className="space-y-4">
                  <QuestionFileUpload
                    topicId={topicId}
                    questionId={questionId}
                    contentAttachments={contentAttachments}
                    criteriaAttachments={criteriaAttachments}
                    instructionsAttachments={instructionsAttachments}
                    onContentAttachmentsChange={setContentAttachments}
                    onCriteriaAttachmentsChange={setCriteriaAttachments}
                    onInstructionsAttachmentsChange={setInstructionsAttachments}
                  />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Display mode - Content (Markdown rendered) */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.content')}</Label>
                {content || question.content_data?.content || question.content_data?.text ? (
                  <div className="rounded-lg border border-border bg-surface p-4">
                    <EnhancedMarkdown
                      source={
                        content ||
                        (question.content_data?.content as string) ||
                        (question.content_data?.text as string) ||
                        ''
                      }
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-text-muted">{t('questions.no_content')}</p>
                )}
                {renderAttachmentList(
                  contentAttachments.length > 0
                    ? contentAttachments
                    : (question.content_data?.attachments as EvalAttachment[] | undefined),
                  t('questions.content_attachments')
                )}
              </div>

              {/* Display mode - Criteria (Markdown rendered) */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.criteria')}</Label>
                {criteria || question.criteria_data?.criteria || question.criteria_data?.text ? (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <EnhancedMarkdown
                      source={
                        criteria ||
                        (question.criteria_data?.criteria as string) ||
                        (question.criteria_data?.text as string) ||
                        ''
                      }
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-text-muted">{t('questions.no_criteria')}</p>
                )}
              </div>

              {/* Display mode - Instructions */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.instructions')}</Label>
                {instructions || question.content_data?.instructions ? (
                  <div className="rounded-lg border border-border bg-surface p-4">
                    <EnhancedMarkdown
                      source={instructions || (question.content_data?.instructions as string) || ''}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-text-muted">{t('questions.instructions_hint')}</p>
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
