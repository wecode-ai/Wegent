// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Eye, EyeOff, FileText, Loader2, Send, Save } from 'lucide-react'
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
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { QuestionFileUpload } from '@wecode/components/evaluation'
import {
  createAuthorQuestion,
  getAuthorQuestion,
  updateAuthorQuestion,
  publishAuthorQuestion,
} from '@wecode/api/evaluation-author'
import { ContentType, type Question, type EvalAttachment } from '@wecode/types/evaluation'

/**
 * Props for the QuestionEditorDrawer component
 */
interface QuestionEditorDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean
  /** Topic ID */
  topicId: number
  /** Question ID (undefined for create mode) */
  questionId?: number
  /** Callback when drawer is closed */
  onClose: () => void
  /** Callback when question is saved/created */
  onQuestionChange?: (question: Question) => void
}

type EditorTab = 'content' | 'criteria' | 'instructions' | 'attachments'

/**
 * QuestionEditorDrawer - Slide-out drawer for creating/editing questions
 *
 * Features:
 * - Slides in from the right side
 * - Four tabs: Content, Criteria, Instructions, Attachments
 * - Create or edit mode based on questionId prop
 * - Save as Draft and Publish buttons
 * - Markdown preview for all text fields
 * - File upload support via QuestionFileUpload component
 */
export function QuestionEditorDrawer({
  isOpen,
  topicId,
  questionId,
  onClose,
  onQuestionChange,
}: QuestionEditorDrawerProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()

  const isEditMode = !!questionId

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [activeTab, setActiveTab] = useState<EditorTab>('content')

  // Form state
  const [title, setTitle] = useState('')
  const [contentType, setContentType] = useState<string>(ContentType.MIXED)

  // Content tab state
  const [contentText, setContentText] = useState('')
  const [showContentPreview, setShowContentPreview] = useState(false)

  // Criteria tab state
  const [criteriaText, setCriteriaText] = useState('')
  const [showCriteriaPreview, setShowCriteriaPreview] = useState(false)

  // Instructions tab state
  const [instructionsText, setInstructionsText] = useState('')
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)

  // Attachments state
  const [contentAttachments, setContentAttachments] = useState<EvalAttachment[]>([])
  const [criteriaAttachments, setCriteriaAttachments] = useState<EvalAttachment[]>([])
  const [instructionsAttachments, setInstructionsAttachments] = useState<EvalAttachment[]>([])

  // Load question data when drawer opens in edit mode
  const loadQuestion = useCallback(async () => {
    if (!isOpen || !isEditMode || !questionId) return

    setLoading(true)
    try {
      const questionData = await getAuthorQuestion(questionId)

      // Populate form fields
      setTitle(questionData.title)
      setContentType(questionData.content_type || ContentType.MIXED)

      // Content
      setContentText(
        (questionData.content_data?.content as string) ||
          (questionData.content_data?.text as string) ||
          ''
      )
      setContentAttachments((questionData.content_data?.attachments as EvalAttachment[]) || [])

      // Criteria
      setCriteriaText(
        (questionData.criteria_data?.criteria as string) ||
          (questionData.criteria_data?.text as string) ||
          ''
      )
      setCriteriaAttachments((questionData.criteria_data?.attachments as EvalAttachment[]) || [])

      // Instructions
      setInstructionsText((questionData.content_data?.instructions as string) || '')
      setInstructionsAttachments(
        (questionData.content_data?.instructionsAttachments as EvalAttachment[]) || []
      )
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

  // Reset form when drawer opens in create mode
  const resetForm = useCallback(() => {
    setTitle('')
    setContentType(ContentType.MIXED)
    setContentText('')
    setCriteriaText('')
    setInstructionsText('')
    setContentAttachments([])
    setCriteriaAttachments([])
    setInstructionsAttachments([])
    setActiveTab('content')
    setShowContentPreview(false)
    setShowCriteriaPreview(false)
    setShowInstructionsPreview(false)
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

  // Validate form
  const validateForm = (): boolean => {
    if (!title.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.title_placeholder'),
        variant: 'destructive',
      })
      return false
    }

    const hasContent =
      contentText.trim().length > 0 ||
      contentAttachments.length > 0 ||
      criteriaAttachments.length > 0 ||
      instructionsAttachments.length > 0

    if (!hasContent) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.content_placeholder'),
        variant: 'destructive',
      })
      return false
    }

    return true
  }

  // Build content data
  const buildContentData = (): Record<string, unknown> => {
    const contentData: Record<string, unknown> = {}

    if (contentText.trim()) {
      contentData.content = contentText.trim()
    }

    if (instructionsText.trim()) {
      contentData.instructions = instructionsText.trim()
    }

    if (contentAttachments.length > 0) {
      contentData.attachments = contentAttachments
    }

    if (instructionsAttachments.length > 0) {
      contentData.instructionsAttachments = instructionsAttachments
    }

    return contentData
  }

  // Build criteria data
  const buildCriteriaData = (): Record<string, unknown> | undefined => {
    const criteriaData: Record<string, unknown> = {}

    if (criteriaText.trim()) {
      criteriaData.criteria = criteriaText.trim()
    }

    if (criteriaAttachments.length > 0) {
      criteriaData.attachments = criteriaAttachments
    }

    return Object.keys(criteriaData).length > 0 ? criteriaData : undefined
  }

  // Handle save as draft
  const handleSaveDraft = async () => {
    if (!validateForm()) return

    setSaving(true)
    try {
      const contentData = buildContentData()
      const criteriaData = buildCriteriaData()

      let result: Question

      if (isEditMode && questionId) {
        result = await updateAuthorQuestion(questionId, {
          title: title.trim(),
          content_type: contentType,
          content_data: contentData,
          criteria_type: criteriaData ? ContentType.MIXED : undefined,
          criteria_data: criteriaData,
        })
      } else {
        result = await createAuthorQuestion(topicId, {
          title: title.trim(),
          content_type: contentType,
          content_data: contentData,
          criteria_type: criteriaData ? ContentType.MIXED : undefined,
          criteria_data: criteriaData,
        })
      }

      toast({
        title: isEditMode
          ? t('questions.updated_success', 'Question updated successfully')
          : t('questions.created_success', 'Question created successfully'),
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

  // Handle save and publish
  const handlePublish = async () => {
    if (!validateForm()) return

    setPublishing(true)
    try {
      const contentData = buildContentData()
      const criteriaData = buildCriteriaData()

      let result: Question

      if (isEditMode && questionId) {
        // Update first, then publish
        result = await updateAuthorQuestion(questionId, {
          title: title.trim(),
          content_type: contentType,
          content_data: contentData,
          criteria_type: criteriaData ? ContentType.MIXED : undefined,
          criteria_data: criteriaData,
        })
        await publishAuthorQuestion(questionId)
      } else {
        // Create first, then publish
        result = await createAuthorQuestion(topicId, {
          title: title.trim(),
          content_type: contentType,
          content_data: contentData,
          criteria_type: criteriaData ? ContentType.MIXED : undefined,
          criteria_data: criteriaData,
        })
        await publishAuthorQuestion(result.id)
      }

      toast({
        title: t('questions.published_success', 'Question published successfully'),
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

  // Prevent body scroll when drawer is open
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
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 transition-opacity"
        onClick={handleCancel}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-3xl transform transition-transform duration-300 ease-in-out bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-[#DF2029]" />
            <h2 className="text-lg font-semibold text-gray-900">
              {isEditMode
                ? t('questions.edit', 'Edit Question')
                : t('questions.create', 'Create Question')}
            </h2>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="h-8 w-8 p-0"
            aria-label={t('common:actions.close')}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex flex-col h-[calc(100vh-180px)]">
          {/* Tab Navigation */}
          <div className="px-6 border-b border-gray-100">
            <div className="flex gap-1">
              {[
                { key: 'content', label: t('questions.content') },
                { key: 'criteria', label: t('questions.criteria') },
                { key: 'instructions', label: t('questions.instructions') },
                { key: 'attachments', label: t('questions.attachments', 'Attachments') },
              ].map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as EditorTab)}
                  className={`px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === tab.key
                      ? 'border-b-2 border-[#DF2029] text-[#DF2029]'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="space-y-4 animate-pulse">
                <div className="h-10 bg-gray-100 rounded" />
                <div className="h-32 bg-gray-100 rounded" />
                <div className="h-32 bg-gray-100 rounded" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* Title - shown in all tabs */}
                <div className="space-y-2">
                  <Label htmlFor="title">
                    {t('questions.question_title', 'Question Title')}{' '}
                    <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder={t('questions.title_placeholder', 'Enter question title')}
                    maxLength={500}
                    disabled={saving || publishing}
                  />
                  <p className="text-xs text-gray-400 text-right">{title.length}/500</p>
                </div>

                {/* Content Type - shown in all tabs */}
                <div className="space-y-2">
                  <Label htmlFor="contentType">{t('questions.content_type', 'Content Type')}</Label>
                  <Select
                    value={contentType}
                    onValueChange={setContentType}
                    disabled={saving || publishing}
                  >
                    <SelectTrigger id="contentType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ContentType.TEXT}>
                        {t('questions.type_text', 'Text')}
                      </SelectItem>
                      <SelectItem value={ContentType.URL}>
                        {t('questions.type_url', 'URL')}
                      </SelectItem>
                      <SelectItem value={ContentType.ATTACHMENT}>
                        {t('questions.type_attachment', 'Attachment')}
                      </SelectItem>
                      <SelectItem value={ContentType.MIXED}>
                        {t('questions.type_mixed', 'Mixed')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Content Tab */}
                {activeTab === 'content' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="contentText">{t('questions.content')} (Markdown)</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowContentPreview(!showContentPreview)}
                          disabled={saving || publishing}
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
                        <div className="min-h-[200px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                          {contentText.trim() ? (
                            <EnhancedMarkdown
                              source={contentText}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          ) : (
                            <p className="text-gray-400">{t('questions.no_content')}</p>
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
                          disabled={saving || publishing}
                        />
                      )}
                      <p className="text-xs text-gray-500">
                        {t(
                          'questions.markdown_hint',
                          'Supports Markdown formatting: **bold**, *italic*, `code`, lists, etc.'
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {/* Criteria Tab */}
                {activeTab === 'criteria' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="criteriaText">{t('questions.criteria')} (Markdown)</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowCriteriaPreview(!showCriteriaPreview)}
                          disabled={saving || publishing}
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
                        <div className="min-h-[200px] rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                          {criteriaText.trim() ? (
                            <EnhancedMarkdown
                              source={criteriaText}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          ) : (
                            <p className="text-gray-400">{t('questions.no_criteria')}</p>
                          )}
                        </div>
                      ) : (
                        <Textarea
                          id="criteriaText"
                          value={criteriaText}
                          onChange={e => setCriteriaText(e.target.value)}
                          placeholder={t('questions.criteria_placeholder')}
                          rows={8}
                          className="font-mono text-sm"
                          disabled={saving || publishing}
                        />
                      )}
                      <p className="text-xs text-gray-500">{t('questions.criteria_placeholder')}</p>
                    </div>
                  </div>
                )}

                {/* Instructions Tab */}
                {activeTab === 'instructions' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="instructionsText">
                          {t('questions.instructions')} (Markdown)
                        </Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowInstructionsPreview(!showInstructionsPreview)}
                          disabled={saving || publishing}
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
                        <div className="min-h-[200px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                          {instructionsText.trim() ? (
                            <EnhancedMarkdown
                              source={instructionsText}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          ) : (
                            <p className="text-gray-400">{t('topics.no_instructions')}</p>
                          )}
                        </div>
                      ) : (
                        <Textarea
                          id="instructionsText"
                          value={instructionsText}
                          onChange={e => setInstructionsText(e.target.value)}
                          placeholder={t('questions.instructions_placeholder')}
                          rows={8}
                          className="font-mono text-sm"
                          disabled={saving || publishing}
                        />
                      )}
                      <p className="text-xs text-gray-500">{t('questions.instructions_hint')}</p>
                    </div>
                  </div>
                )}

                {/* Attachments Tab */}
                {activeTab === 'attachments' && (
                  <div className="space-y-4">
                    <QuestionFileUpload
                      topicId={topicId}
                      questionId={questionId}
                      contentAttachments={contentAttachments}
                      criteriaAttachments={criteriaAttachments}
                      instructionsAttachments={instructionsAttachments}
                      onContentAttachmentsChange={setContentAttachments}
                      onCriteriaAttachmentsChange={setCriteriaAttachments}
                      onInstructionsAttachmentsChange={setInstructionsAttachments}
                      disabled={saving || publishing}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-gray-100 bg-white">
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={saving || publishing}
            >
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleSaveDraft}
              disabled={saving || publishing || loading}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:actions.saving', 'Saving...')}
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {t('actions.save_draft', 'Save as Draft')}
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handlePublish}
              disabled={saving || publishing || loading}
              className="bg-[#DF2029] hover:bg-[#c81d25]"
            >
              {publishing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('actions.publishing', 'Publishing...')}
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  {t('actions.publish', 'Publish')}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
