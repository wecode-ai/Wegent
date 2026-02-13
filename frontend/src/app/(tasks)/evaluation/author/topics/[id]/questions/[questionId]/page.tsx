// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Edit, Trash2, Send, X, Check, File, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import {
  getAuthorQuestion,
  updateAuthorQuestion,
  deleteAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import { ContentType, QuestionStatus, type Question, type EvalAttachment } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'

function QuestionDetailContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.questionId as string)

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  // Form state
  const [title, setTitle] = useState('')
  const [contentType, setContentType] = useState<string>(ContentType.TEXT)
  const [contentText, setContentText] = useState('')
  const [contentUrl, setContentUrl] = useState('')
  const [contentAttachments, setContentAttachments] = useState<EvalAttachment[]>([])
  const [criteriaType, setCriteriaType] = useState<string>(ContentType.TEXT)
  const [criteriaText, setCriteriaText] = useState('')
  const [criteriaUrl, setCriteriaUrl] = useState('')
  const [criteriaAttachments, setCriteriaAttachments] = useState<EvalAttachment[]>([])

  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const questionData = await getAuthorQuestion(questionId)
      setQuestion(questionData)
      // Populate form fields
      setTitle(questionData.title)
      setContentType(questionData.content_type || ContentType.TEXT)
      setContentText((questionData.content_data?.text as string) || '')
      setContentUrl((questionData.content_data?.url as string) || '')
      setContentAttachments((questionData.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaType(questionData.criteria_type || ContentType.TEXT)
      setCriteriaText((questionData.criteria_data?.text as string) || '')
      setCriteriaUrl((questionData.criteria_data?.url as string) || '')
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
      setContentType(question.content_type || ContentType.TEXT)
      setContentText((question.content_data?.text as string) || '')
      setContentUrl((question.content_data?.url as string) || '')
      setContentAttachments((question.content_data?.attachments as EvalAttachment[]) || [])
      setCriteriaType(question.criteria_type || ContentType.TEXT)
      setCriteriaText((question.criteria_data?.text as string) || '')
      setCriteriaUrl((question.criteria_data?.url as string) || '')
      setCriteriaAttachments((question.criteria_data?.attachments as EvalAttachment[]) || [])
    }
    setIsEditing(false)
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

    setSaving(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (contentType === ContentType.TEXT || contentType === ContentType.MIXED) {
        contentData.text = contentText.trim()
      }
      if (contentType === ContentType.URL || contentType === ContentType.MIXED) {
        contentData.url = contentUrl.trim()
      }
      if (
        (contentType === ContentType.ATTACHMENT || contentType === ContentType.MIXED) &&
        contentAttachments.length > 0
      ) {
        contentData.attachments = contentAttachments
      }

      const criteriaData: Record<string, unknown> = {}
      if (criteriaType === ContentType.TEXT || criteriaType === ContentType.MIXED) {
        if (criteriaText.trim()) {
          criteriaData.text = criteriaText.trim()
        }
      }
      if (criteriaType === ContentType.URL || criteriaType === ContentType.MIXED) {
        if (criteriaUrl.trim()) {
          criteriaData.url = criteriaUrl.trim()
        }
      }
      if (
        (criteriaType === ContentType.ATTACHMENT || criteriaType === ContentType.MIXED) &&
        criteriaAttachments.length > 0
      ) {
        criteriaData.attachments = criteriaAttachments
      }

      await updateAuthorQuestion(questionId, {
        title: title.trim(),
        content_type: contentType,
        content_data: contentData,
        criteria_type: criteriaType,
        criteria_data: Object.keys(criteriaData).length > 0 ? criteriaData : undefined,
      })

      toast({
        title: t('questions.updated_success'),
        description: '',
      })
      setIsEditing(false)
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

  const handleDownload = async (attachment: EvalAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  // Helper function to get status label with i18n
  const getStatusText = (status: number) => {
    if (status === QuestionStatus.DRAFT) {
      return t('common.draft')
    }
    return t('topics.published')
  }

  // Helper function to get content type label
  const getContentTypeText = (type: string) => {
    return t(`questions.content_types.${type}`, type)
  }

  // Check if content type should show attachment upload
  const showContentAttachment =
    contentType === ContentType.ATTACHMENT || contentType === ContentType.MIXED
  const showCriteriaAttachment =
    criteriaType === ContentType.ATTACHMENT || criteriaType === ContentType.MIXED

  // Render attachment list (for display mode)
  const renderAttachmentList = (attachments: EvalAttachment[] | undefined) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="space-y-2">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.key || index}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
          >
            <File className="h-4 w-4 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
            {attachment.file_size && (
              <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleDownload(attachment)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="mt-2 h-4 w-1/4" />
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-10 w-full" />
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
    <div className="container mx-auto max-w-2xl px-4 py-8">
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
          {!isEditing && (
            <p className="text-sm text-text-secondary">
              {t('questions.content_type')}: {getContentTypeText(question.content_type)}
              {question.criteria_type && (
                <> | {t('questions.criteria_type')}: {getContentTypeText(question.criteria_type)}</>
              )}
            </p>
          )}
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

              {/* Content Type */}
              <div className="space-y-2">
                <Label htmlFor="contentType">{t('questions.content_type')}</Label>
                <Select value={contentType} onValueChange={setContentType}>
                  <SelectTrigger id="contentType">
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

              {/* Content Text */}
              {(contentType === ContentType.TEXT || contentType === ContentType.MIXED) && (
                <div className="space-y-2">
                  <Label htmlFor="contentText">{t('questions.content')}</Label>
                  <Textarea
                    id="contentText"
                    value={contentText}
                    onChange={e => setContentText(e.target.value)}
                    placeholder={t('questions.content_placeholder')}
                    rows={6}
                  />
                </div>
              )}

              {/* Content URL */}
              {(contentType === ContentType.URL || contentType === ContentType.MIXED) && (
                <div className="space-y-2">
                  <Label htmlFor="contentUrl">URL</Label>
                  <Input
                    id="contentUrl"
                    type="url"
                    value={contentUrl}
                    onChange={e => setContentUrl(e.target.value)}
                    placeholder="https://example.com"
                  />
                </div>
              )}

              {/* Content Attachments */}
              {showContentAttachment && (
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
              )}

              {/* Criteria Type */}
              <div className="space-y-2">
                <Label htmlFor="criteriaType">{t('questions.criteria_type')}</Label>
                <Select value={criteriaType} onValueChange={setCriteriaType}>
                  <SelectTrigger id="criteriaType">
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

              {/* Criteria Text */}
              {(criteriaType === ContentType.TEXT || criteriaType === ContentType.MIXED) && (
                <div className="space-y-2">
                  <Label htmlFor="criteriaText">{t('questions.criteria')}</Label>
                  <Textarea
                    id="criteriaText"
                    value={criteriaText}
                    onChange={e => setCriteriaText(e.target.value)}
                    placeholder={t('questions.criteria_placeholder')}
                    rows={4}
                  />
                  <p className="text-xs text-text-muted">{t('grading.description')}</p>
                </div>
              )}

              {/* Criteria URL */}
              {(criteriaType === ContentType.URL || criteriaType === ContentType.MIXED) && (
                <div className="space-y-2">
                  <Label htmlFor="criteriaUrl">{t('questions.criteria')} URL</Label>
                  <Input
                    id="criteriaUrl"
                    type="url"
                    value={criteriaUrl}
                    onChange={e => setCriteriaUrl(e.target.value)}
                    placeholder="https://example.com/criteria"
                  />
                </div>
              )}

              {/* Criteria Attachments */}
              {showCriteriaAttachment && (
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
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Display mode - Content */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.content')}</Label>
                {typeof question.content_data?.text === 'string' && question.content_data.text && (
                  <p className="whitespace-pre-wrap text-text-primary">
                    {question.content_data.text}
                  </p>
                )}
                {typeof question.content_data?.url === 'string' && question.content_data.url && (
                  <a
                    href={question.content_data.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {question.content_data.url}
                  </a>
                )}
                {renderAttachmentList(question.content_data?.attachments as EvalAttachment[])}
                {typeof question.content_data?.text !== 'string' &&
                  typeof question.content_data?.url !== 'string' &&
                  !(question.content_data?.attachments as EvalAttachment[])?.length && (
                    <p className="text-text-muted">-</p>
                  )}
              </div>

              {/* Display mode - Criteria */}
              <div className="space-y-2">
                <Label className="text-text-secondary">{t('questions.criteria')}</Label>
                {typeof question.criteria_data?.text === 'string' && question.criteria_data.text && (
                  <p className="whitespace-pre-wrap text-text-primary">
                    {question.criteria_data.text}
                  </p>
                )}
                {typeof question.criteria_data?.url === 'string' && question.criteria_data.url && (
                  <a
                    href={question.criteria_data.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {question.criteria_data.url}
                  </a>
                )}
                {renderAttachmentList(question.criteria_data?.attachments as EvalAttachment[])}
                {typeof question.criteria_data?.text !== 'string' &&
                  typeof question.criteria_data?.url !== 'string' &&
                  !(question.criteria_data?.attachments as EvalAttachment[])?.length && (
                    <p className="text-text-muted">-</p>
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
