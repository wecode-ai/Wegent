// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Eye, EyeOff, FileText, Loader2, Send, Save, FileArchive, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ExamMarkdownContent, IconSelector } from '../exam'
import type { IconName } from '../exam/ExamIcons'
import {
  createAuthorQuestion,
  getAuthorQuestion,
  updateAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import type { Question } from '@wecode/types/evaluation'
import type { ExamQuestionContent, ExamAttachment, AnswerSlot } from '@wecode/types/evaluation-exam'
import { createDefaultQuestionContent, isExamQuestionContent } from '@wecode/types/evaluation-exam'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { MultiFileUpload } from '../common/FileUploadComponents'
import { SlotConfigEditor } from './SlotConfigEditor'

interface QuestionEditorDrawerProps {
  isOpen: boolean
  topicId: number
  questionId?: number
  onClose: () => void
  onQuestionChange?: (question: Question) => void
}

export function QuestionEditorDrawer({
  isOpen,
  topicId,
  questionId,
  onClose,
  onQuestionChange,
}: QuestionEditorDrawerProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const isEditMode = !!questionId

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState<ExamQuestionContent>(createDefaultQuestionContent())

  // Material package (ZIP) attachments
  const [attachments, setAttachments] = useState<ExamAttachment[]>([])

  // Answer slots configuration
  const [answerSlots, setAnswerSlots] = useState<AnswerSlot[]>([])

  const loadQuestion = useCallback(async () => {
    if (!isOpen || !isEditMode || !questionId) return

    setLoading(true)
    try {
      const questionData = await getAuthorQuestion(questionId)
      setTitle(questionData.title)

      const contentData = questionData.content_data || {}
      if (isExamQuestionContent(contentData)) {
        setContent(contentData)
        setAttachments(contentData.attachments || [])
        setAnswerSlots(contentData.answerSlots || [])
      } else {
        setContent({
          display: {
            icon: 'file',
            shortDesc: '',
          },
          contentMarkdown: (contentData.content as string) || (contentData.text as string) || '',
        })
        setAttachments([])
        setAnswerSlots([])
      }
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      onClose()
    } finally {
      setLoading(false)
    }
  }, [isOpen, isEditMode, questionId, toast, t, onClose])

  const resetForm = useCallback(() => {
    setTitle('')
    setContent(createDefaultQuestionContent())
    setAttachments([])
    setAnswerSlots([])
    setShowPreview(false)
  }, [])

  useEffect(() => {
    if (isOpen) {
      if (isEditMode) {
        loadQuestion()
      } else {
        resetForm()
      }
    }
  }, [isOpen, isEditMode, loadQuestion, resetForm])

  const validateForm = (): boolean => {
    if (!title.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.exam_content.title_required'),
        variant: 'destructive',
      })
      return false
    }

    if (!content.contentMarkdown.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.exam_content.content_required'),
        variant: 'destructive',
      })
      return false
    }

    return true
  }

  // Build content data with attachments and answer slots
  const buildContentData = (): ExamQuestionContent => {
    return {
      ...content,
      attachments: attachments.length > 0 ? attachments : undefined,
      answerSlots: answerSlots.length > 0 ? answerSlots : undefined,
    }
  }

  const handleSaveDraft = async () => {
    if (!validateForm()) return

    setSaving(true)
    try {
      let result: Question
      const contentData = buildContentData()

      if (isEditMode && questionId) {
        result = await updateAuthorQuestion(questionId, {
          title: title.trim(),
          content_type: 'exam',
          content_data: contentData as unknown as Record<string, unknown>,
        })
      } else {
        result = await createAuthorQuestion(topicId, {
          title: title.trim(),
          content_type: 'exam',
          content_data: contentData as unknown as Record<string, unknown>,
        })
      }

      toast({
        title: isEditMode ? t('questions.updated_success') : t('questions.created_success'),
        description: '',
      })

      onQuestionChange?.(result)
      onClose()
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
    if (!validateForm()) return

    setPublishing(true)
    try {
      let result: Question
      const contentData = buildContentData()

      if (isEditMode && questionId) {
        result = await updateAuthorQuestion(questionId, {
          title: title.trim(),
          content_type: 'exam',
          content_data: contentData as unknown as Record<string, unknown>,
        })
        await publishAuthorQuestion(questionId)
      } else {
        result = await createAuthorQuestion(topicId, {
          title: title.trim(),
          content_type: 'exam',
          content_data: contentData as unknown as Record<string, unknown>,
        })
        await publishAuthorQuestion(result.id)
      }

      toast({
        title: t('questions.published_success'),
        description: '',
      })

      onQuestionChange?.(result)
      onClose()
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

  const handleCancel = () => {
    onClose()
  }

  // ZIP file validation
  const validateZipFile = (file: File): string | null => {
    if (
      !file.name.toLowerCase().endsWith('.zip') &&
      file.type !== 'application/zip' &&
      file.type !== 'application/x-zip-compressed'
    ) {
      return t('questions.exam_content.material_zip_accept')
    }
    return null
  }

  const handleUploadError = (error: Error) => {
    toast({
      title: t('errors.save_failed'),
      description: error.message,
      variant: 'destructive',
    })
  }

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 transition-opacity"
        onClick={handleCancel}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-4xl transform transition-transform duration-300 ease-in-out bg-white shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-[#DF2029]" />
            <h2 className="text-lg font-semibold text-gray-900">
              {isEditMode ? t('questions.edit') : t('questions.create')}
            </h2>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <Button variant="ghost" size="sm" onClick={handleCancel} className="h-8 w-8 p-0">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex flex-col h-[calc(100vh-180px)]">
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="space-y-4 animate-pulse">
                <div className="h-10 bg-gray-100 rounded" />
                <div className="h-32 bg-gray-100 rounded" />
                <div className="h-32 bg-gray-100 rounded" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* Basic Info Section */}
                <div className="space-y-2">
                  <Label htmlFor="title">
                    {t('questions.question_title')} <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder={t('questions.title_placeholder')}
                    maxLength={500}
                    disabled={saving || publishing}
                    data-testid="question-title-input"
                  />
                  <p className="text-xs text-gray-400 text-right">{title.length}/500</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('questions.exam_content.icon')}</Label>
                    <IconSelector
                      value={(content.display.icon as IconName) || 'file'}
                      onChange={iconName =>
                        setContent({
                          ...content,
                          display: { ...content.display, icon: iconName },
                        })
                      }
                      disabled={saving || publishing}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="shortDesc">{t('questions.exam_content.short_desc')}</Label>
                    <Input
                      id="shortDesc"
                      value={content.display.shortDesc}
                      onChange={e =>
                        setContent({
                          ...content,
                          display: { ...content.display, shortDesc: e.target.value },
                        })
                      }
                      placeholder={t('questions.exam_content.short_desc_placeholder')}
                      disabled={saving || publishing}
                    />
                  </div>
                </div>

                {/* Content Section */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-gray-900">
                      {t('questions.question_content')}
                    </h4>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowPreview(!showPreview)}
                      disabled={saving || publishing}
                    >
                      {showPreview ? (
                        <>
                          <EyeOff className="mr-1 h-4 w-4" /> {t('questions.exam_content.edit')}
                        </>
                      ) : (
                        <>
                          <Eye className="mr-1 h-4 w-4" /> {t('questions.exam_content.preview')}
                        </>
                      )}
                    </Button>
                  </div>

                  {showPreview ? (
                    <div className="min-h-[400px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                      {content.contentMarkdown.trim() ? (
                        <ExamMarkdownContent content={content.contentMarkdown} bare />
                      ) : (
                        <p className="text-gray-400">{t('questions.exam_content.no_content')}</p>
                      )}
                    </div>
                  ) : (
                    <Textarea
                      value={content.contentMarkdown}
                      onChange={e => setContent({ ...content, contentMarkdown: e.target.value })}
                      placeholder={t('questions.exam_content.content_placeholder')}
                      rows={16}
                      className="font-mono text-sm"
                      disabled={saving || publishing}
                    />
                  )}

                  <p className="text-xs text-gray-500">
                    {t('questions.exam_content.content_hint')}
                  </p>
                </div>

                {/* Material Package (ZIP) Upload Section */}
                <div className="space-y-4 border-t border-gray-200 pt-6">
                  <div className="flex items-center gap-2">
                    <FileArchive className="h-5 w-5 text-[#DF2029]" />
                    <h4 className="text-sm font-semibold text-gray-900">
                      {t('questions.exam_content.material_zip')}
                    </h4>
                  </div>
                  <p className="text-xs text-gray-500">
                    {t('questions.exam_content.material_zip_hint')}
                  </p>

                  <MultiFileUpload
                    accept=".zip,application/zip,application/x-zip-compressed"
                    hint={t('questions.exam_content.material_zip_accept')}
                    uploadText={t('questions.exam_content.material_zip_upload')}
                    fileType="question_content"
                    topicId={topicId}
                    questionId={questionId}
                    slot="material"
                    maxFiles={5}
                    maxSize={500 * 1024 * 1024}
                    disabled={saving || publishing}
                    attachments={attachments}
                    onChange={setAttachments}
                    validateFile={validateZipFile}
                    onUploadError={handleUploadError}
                  />
                </div>

                {/* Answer Slots Configuration */}
                <div className="space-y-4 border-t border-gray-200 pt-6">
                  <div className="flex items-center gap-2">
                    <Settings className="h-5 w-5 text-[#DF2029]" />
                    <h4 className="text-sm font-semibold text-gray-900">{t('slots.title')}</h4>
                  </div>
                  <p className="text-xs text-gray-500">{t('slots.description')}</p>
                  <SlotConfigEditor
                    slots={answerSlots}
                    onChange={setAnswerSlots}
                    disabled={saving || publishing}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-gray-100 bg-white">
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={saving || publishing}
            >
              {t('questions.exam_content.cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleSaveDraft}
              disabled={saving || publishing || loading}
              data-testid="save-draft-button"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />{' '}
                  {t('questions.exam_content.updating')}
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> {t('questions.exam_content.save_draft')}
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handlePublish}
              disabled={saving || publishing || loading}
              className="bg-[#DF2029] hover:bg-[#c81d25]"
              data-testid="publish-button"
            >
              {publishing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />{' '}
                  {t('questions.exam_content.publishing')}
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" /> {t('questions.exam_content.publish')}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
