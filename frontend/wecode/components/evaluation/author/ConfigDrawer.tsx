// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Eye, EyeOff, Info, GraduationCap, Loader2 } from 'lucide-react'
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
// Tabs component imported but using custom tab implementation for drawer
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { getAuthorTopic, updateAuthorTopic } from '@wecode/api/evaluation-author'
import { TopicVisibility, type Topic } from '@wecode/types/evaluation'
import type { ExamTopicExtraData } from '@wecode/types/evaluation-exam'

/**
 * Props for the ConfigDrawer component
 */
interface ConfigDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean
  /** Topic ID to edit */
  topicId: number
  /** Callback when drawer is closed */
  onClose: () => void
  /** Callback when topic is updated */
  onTopicUpdate?: (topic: Topic) => void
}

type TabType = 'basic' | 'exam'

/**
 * ConfigDrawer - Slide-out drawer for topic configuration
 *
 * Features:
 * - Slides in from the right side
 * - Two tabs: Basic Info and Exam Config
 * - Form validation
 * - Loading states
 * - Markdown preview for instructions
 */
export function ConfigDrawer({ isOpen, topicId, onClose, onTopicUpdate }: ConfigDrawerProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()

  const [topic, setTopic] = useState<Topic | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('basic')

  // Basic form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<string>(TopicVisibility.PRIVATE)
  const [instructions, setInstructions] = useState('')
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)

  // Exam config state (three-phase: intro, exam, review)
  const [introMinutes, setIntroMinutes] = useState(5)
  const [examMinutes, setExamMinutes] = useState(50)
  const [reviewMinutes, setReviewMinutes] = useState(5)
  const [examInstructions, setExamInstructions] = useState('')
  const [showExamInstructionsPreview, setShowExamInstructionsPreview] = useState(false)

  // Load topic data when drawer opens
  const loadData = useCallback(async () => {
    if (!isOpen || !topicId) return

    setLoading(true)
    try {
      const topicData = await getAuthorTopic(topicId)
      setTopic(topicData)

      // Load basic info
      setName(topicData.name)
      setDescription(topicData.description || '')
      setVisibility(topicData.visibility)
      setInstructions((topicData.extra_data?.instructions as string) || '')

      // Load exam config from extra_data (three-phase structure)
      const extraData = topicData.extra_data as Record<string, unknown> | undefined
      const examData = extraData as unknown as ExamTopicExtraData | undefined
      if (examData?.duration) {
        setIntroMinutes(examData.duration.intro || 5)
        setExamMinutes(examData.duration.exam || 50)
        setReviewMinutes(examData.duration.review || 5)
      }
      setExamInstructions(examData?.instructions || '')
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
  }, [isOpen, topicId, toast, t, onClose])

  useEffect(() => {
    if (isOpen) {
      loadData()
    }
  }, [isOpen, loadData])

  // Reset form when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setActiveTab('basic')
      setShowInstructionsPreview(false)
      setShowExamInstructionsPreview(false)
    }
  }, [isOpen])

  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('topics.name') + ' is required',
        variant: 'destructive',
      })
      return
    }

    setSaving(true)
    try {
      const currentExtraData = topic?.extra_data || {}

      // Build exam config (three-phase structure)
      const examData: ExamTopicExtraData = {
        duration: {
          intro: introMinutes,
          exam: examMinutes,
          review: reviewMinutes,
        },
        instructions: examInstructions.trim(),
      }

      const updatedTopic = await updateAuthorTopic(topicId, {
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
        instructions: instructions.trim() || undefined,
        extra_data: {
          ...currentExtraData,
          duration: examData.duration,
          instructions: examData.instructions,
        },
      })

      toast({
        title: t('topics.updated_success', 'Topic updated successfully'),
        description: '',
      })

      onTopicUpdate?.(updatedTopic)
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
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl transform transition-transform duration-300 ease-in-out bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">
              {t('topics.config_title', 'Topic Configuration')}
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
        <div className="flex flex-col h-[calc(100vh-140px)]">
          {/* Tab Navigation */}
          <div className="px-6 border-b border-gray-100">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveTab('basic')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'basic'
                    ? 'border-b-2 border-[#DF2029] text-[#DF2029]'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Info className="h-4 w-4" />
                {t('topics.basic_info', 'Basic Info')}
              </button>
              <button
                onClick={() => setActiveTab('exam')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'exam'
                    ? 'border-b-2 border-[#DF2029] text-[#DF2029]'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <GraduationCap className="h-4 w-4" />
                {t('topics.exam_config', 'Exam Config')}
              </button>
            </div>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="space-y-4 animate-pulse">
                <div className="h-10 bg-gray-100 rounded" />
                <div className="h-32 bg-gray-100 rounded" />
                <div className="h-10 bg-gray-100 rounded" />
              </div>
            ) : (
              <>
                {/* Basic Info Tab */}
                {activeTab === 'basic' && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label htmlFor="name">
                        {t('topics.name', 'Topic Name')} <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="name"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder={t('topics.name', 'Topic Name')}
                        maxLength={200}
                        disabled={saving}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="description">{t('topics.description', 'Description')}</Label>
                      <Textarea
                        id="description"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        placeholder={t('topics.description', 'Description')}
                        rows={4}
                        maxLength={2000}
                        disabled={saving}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="visibility">{t('topics.visibility', 'Visibility')}</Label>
                      <Select value={visibility} onValueChange={setVisibility} disabled={saving}>
                        <SelectTrigger id="visibility">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="private">{t('topics.private', 'Private')}</SelectItem>
                          <SelectItem value="public">{t('topics.public', 'Public')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-gray-500">
                        {visibility === 'public'
                          ? t(
                              'topics.public_description',
                              'Anyone can view and answer questions in this topic'
                            )
                          : t(
                              'topics.private_description',
                              'Only invited users can view and answer questions'
                            )}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="instructions">{t('topics.instructions')}</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowInstructionsPreview(!showInstructionsPreview)}
                          disabled={saving}
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
                        <div className="min-h-[150px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                          {instructions.trim() ? (
                            <EnhancedMarkdown
                              source={instructions}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          ) : (
                            <p className="text-gray-400">{t('topics.no_instructions')}</p>
                          )}
                        </div>
                      ) : (
                        <Textarea
                          id="instructions"
                          value={instructions}
                          onChange={e => setInstructions(e.target.value)}
                          placeholder={t('topics.instructions_placeholder')}
                          rows={8}
                          className="font-mono text-sm"
                          disabled={saving}
                        />
                      )}
                      <p className="text-xs text-gray-500">{t('topics.instructions_hint')}</p>
                    </div>
                  </div>
                )}

                {/* Exam Config Tab */}
                {activeTab === 'exam' && (
                  <div className="space-y-8">
                    {/* Duration - Three Phase */}
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <Label htmlFor="introMinutes">
                          {t('evaluation:exam.intro_duration', 'Intro Duration (minutes)')}
                        </Label>
                        <Input
                          id="introMinutes"
                          type="number"
                          value={introMinutes}
                          onChange={e => setIntroMinutes(parseInt(e.target.value) || 0)}
                          min={0}
                          disabled={saving}
                        />
                        <p className="text-xs text-gray-500">
                          {t('evaluation:exam.intro_hint', 'Pre-exam introduction and Q&A')}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="examMinutes">
                          {t('evaluation:exam.exam_duration', 'Exam Duration (minutes)')}
                        </Label>
                        <Input
                          id="examMinutes"
                          type="number"
                          value={examMinutes}
                          onChange={e => setExamMinutes(parseInt(e.target.value) || 0)}
                          min={1}
                          disabled={saving}
                        />
                        <p className="text-xs text-gray-500">
                          {t('evaluation:exam.exam_hint', 'Main exam answering time')}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="reviewMinutes">
                          {t('evaluation:exam.review_duration', 'Review Duration (minutes)')}
                        </Label>
                        <Input
                          id="reviewMinutes"
                          type="number"
                          value={reviewMinutes}
                          onChange={e => setReviewMinutes(parseInt(e.target.value) || 0)}
                          min={0}
                          disabled={saving}
                        />
                        <p className="text-xs text-gray-500">
                          {t('evaluation:exam.review_hint', 'Final review and submission check')}
                        </p>
                      </div>
                    </div>

                    {/* Exam Instructions */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="examInstructions">
                          {t('evaluation:exam.instructions', 'Exam Instructions')}
                        </Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setShowExamInstructionsPreview(!showExamInstructionsPreview)
                          }
                          disabled={saving}
                        >
                          {showExamInstructionsPreview ? (
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
                      {showExamInstructionsPreview ? (
                        <div className="min-h-[200px] rounded-lg border border-gray-200 bg-gray-50 p-4">
                          {examInstructions.trim() ? (
                            <EnhancedMarkdown
                              source={examInstructions}
                              theme={theme === 'dark' ? 'dark' : 'light'}
                            />
                          ) : (
                            <p className="text-gray-400">
                              {t(
                                'evaluation:exam.no_instructions',
                                'No exam instructions added yet'
                              )}
                            </p>
                          )}
                        </div>
                      ) : (
                        <Textarea
                          id="examInstructions"
                          value={examInstructions}
                          onChange={e => setExamInstructions(e.target.value)}
                          placeholder={t(
                            'evaluation:exam.instructions_placeholder',
                            'Enter exam instructions in Markdown format...'
                          )}
                          rows={12}
                          className="font-mono text-sm"
                          disabled={saving}
                        />
                      )}
                      <p className="text-xs text-gray-500">
                        {t(
                          'evaluation:exam.instructions_hint',
                          'These instructions will be displayed to participants before the exam starts. Supports Markdown formatting.'
                        )}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-gray-100 bg-white">
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={handleCancel} disabled={saving}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleSave}
              disabled={saving || loading}
              className="bg-[#DF2029] hover:bg-[#c81d25]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:actions.saving', 'Saving...')}
                </>
              ) : (
                t('common:actions.save', 'Save')
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
