// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Eye, EyeOff, GraduationCap, Settings, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { getAuthorTopic, updateAuthorTopic } from '@wecode/api/evaluation-author'
import { TopicVisibility, type Topic } from '@wecode/types/evaluation'
import type { ExamTopicExtraData } from '@wecode/types/evaluation-exam'
import { useTranslation } from '@/hooks/useTranslation'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

type TabType = 'basic' | 'exam'

function ConfigPageContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('basic')

  // Basic form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<string>(TopicVisibility.PRIVATE)
  const [instructions, setInstructions] = useState('')
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)
  const [isExamMode, setIsExamMode] = useState(false)

  // Exam config state (three-phase: intro, exam, review)
  const [introMinutes, setIntroMinutes] = useState(5)
  const [examMinutes, setExamMinutes] = useState(50)
  const [reviewMinutes, setReviewMinutes] = useState(5)
  const [examInstructions, setExamInstructions] = useState('')
  const [showExamInstructionsPreview, setShowExamInstructionsPreview] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const topicData = await getAuthorTopic(topicId)
      setTopic(topicData)

      // Load basic info
      setName(topicData.name)
      setDescription(topicData.description || '')
      setVisibility(topicData.visibility)
      setInstructions((topicData.extra_data?.instructions as string) || '')
      setIsExamMode(topicData.extra_data?.examMode === true)

      // Load exam config from extra_data (three-phase structure)
      const extraData = topicData.extra_data as Record<string, unknown> | undefined
      const examData =
        extraData?.examMode === true ? (extraData as unknown as ExamTopicExtraData) : undefined
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

      // Build exam config if exam mode is enabled (three-phase structure)
      let examData: ExamTopicExtraData | undefined
      if (isExamMode) {
        examData = {
          examMode: true,
          duration: {
            intro: introMinutes,
            exam: examMinutes,
            review: reviewMinutes,
          },
          instructions: examInstructions.trim(),
        }
      }

      await updateAuthorTopic(topicId, {
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
        instructions: instructions.trim() || undefined,
        extra_data: {
          ...currentExtraData,
          examMode: isExamMode,
          ...(examData && {
            examMode: true,
            duration: examData.duration,
            instructions: examData.instructions,
          }),
        },
      })

      toast({
        title: t('topics.updated_success', 'Topic updated successfully'),
        description: '',
      })
      router.push(`/evaluation/author/topics/${topicId}`)
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

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!topic) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('actions.back', 'Back')}
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-primary" />
            <CardTitle>{t('topics.config_title', 'Topic Configuration')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* Tab Navigation */}
          <div className="mb-6 border-b border-border">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveTab('basic')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'basic'
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Info className="h-4 w-4" />
                {t('topics.basic_info', 'Basic Info')}
              </button>
              <button
                onClick={() => isExamMode && setActiveTab('exam')}
                disabled={!isExamMode}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'exam'
                    ? 'border-b-2 border-primary text-primary'
                    : isExamMode
                      ? 'text-text-secondary hover:text-text-primary'
                      : 'cursor-not-allowed text-text-muted'
                }`}
              >
                <GraduationCap className="h-4 w-4" />
                {t('topics.exam_config', 'Exam Config')}
                {!isExamMode && (
                  <span className="ml-1 text-xs">
                    ({t('topics.enable_exam_mode_first', 'Enable exam mode first')})
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Basic Info Tab */}
          {activeTab === 'basic' && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name">{t('topics.name', 'Topic Name')} *</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('topics.name', 'Topic Name')}
                  maxLength={200}
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
                />
              </div>

              {/* Exam Mode Toggle - Prominent placement */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <GraduationCap className="h-5 w-5 text-primary" />
                      <Label htmlFor="examMode" className="text-base font-medium">
                        {t('topics.exam_mode', 'Exam Mode')}
                      </Label>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">
                      {isExamMode
                        ? t(
                            'topics.exam_mode_enabled',
                            'This topic will be displayed as an exam with timer and enhanced UI'
                          )
                        : t('topics.exam_mode_disabled', 'Standard Q&A mode')}
                    </p>
                  </div>
                  <Switch id="examMode" checked={isExamMode} onCheckedChange={setIsExamMode} />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="visibility">{t('topics.visibility', 'Visibility')}</Label>
                <Select value={visibility} onValueChange={setVisibility}>
                  <SelectTrigger id="visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">{t('topics.private', 'Private')}</SelectItem>
                    <SelectItem value="public">{t('topics.public', 'Public')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-text-muted">
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
                  >
                    {showInstructionsPreview ? (
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
                    placeholder={t('topics.instructions_placeholder')}
                    rows={8}
                    className="font-mono text-sm"
                  />
                )}
                <p className="text-xs text-text-muted">{t('topics.instructions_hint')}</p>
              </div>
            </div>
          )}

          {/* Exam Config Tab */}
          {activeTab === 'exam' && isExamMode && (
            <div className="space-y-8">
              {/* Duration - Three Phase */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="introMinutes">
                    {t('grading:exam.intro_duration', 'Intro Duration (minutes)')}
                  </Label>
                  <Input
                    id="introMinutes"
                    type="number"
                    value={introMinutes}
                    onChange={e => setIntroMinutes(parseInt(e.target.value) || 0)}
                    min={0}
                  />
                  <p className="text-xs text-text-muted">
                    {t('grading:exam.intro_hint', 'Pre-exam introduction and Q&A')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="examMinutes">
                    {t('grading:exam.exam_duration', 'Exam Duration (minutes)')}
                  </Label>
                  <Input
                    id="examMinutes"
                    type="number"
                    value={examMinutes}
                    onChange={e => setExamMinutes(parseInt(e.target.value) || 0)}
                    min={1}
                  />
                  <p className="text-xs text-text-muted">
                    {t('grading:exam.exam_hint', 'Main exam answering time')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reviewMinutes">
                    {t('grading:exam.review_duration', 'Review Duration (minutes)')}
                  </Label>
                  <Input
                    id="reviewMinutes"
                    type="number"
                    value={reviewMinutes}
                    onChange={e => setReviewMinutes(parseInt(e.target.value) || 0)}
                    min={0}
                  />
                  <p className="text-xs text-text-muted">
                    {t('grading:exam.review_hint', 'Final review and submission check')}
                  </p>
                </div>
              </div>

              {/* Exam Instructions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="examInstructions">
                    {t('grading:exam.instructions', 'Exam Instructions')}
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowExamInstructionsPreview(!showExamInstructionsPreview)}
                  >
                    {showExamInstructionsPreview ? (
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
                {showExamInstructionsPreview ? (
                  <div className="min-h-[200px] rounded-lg border border-border bg-surface p-4">
                    {examInstructions.trim() ? (
                      <EnhancedMarkdown
                        source={examInstructions}
                        theme={theme === 'dark' ? 'dark' : 'light'}
                      />
                    ) : (
                      <p className="text-text-muted">
                        {t('grading:exam.no_instructions', 'No exam instructions added yet')}
                      </p>
                    )}
                  </div>
                ) : (
                  <Textarea
                    id="examInstructions"
                    value={examInstructions}
                    onChange={e => setExamInstructions(e.target.value)}
                    placeholder={t(
                      'grading:exam.instructions_placeholder',
                      'Enter exam instructions in Markdown format...'
                    )}
                    rows={12}
                    className="font-mono text-sm"
                  />
                )}
                <p className="text-xs text-text-muted">
                  {t(
                    'grading:exam.instructions_hint',
                    'These instructions will be displayed to participants before the exam starts. Supports Markdown formatting.'
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-4 pt-6 mt-6 border-t border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
            >
              {t('actions.cancel', 'Cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? <span>...</span> : t('actions.save', 'Save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default function ConfigPage() {
  return (
    <EvaluationPageLayout>
      <ConfigPageContent />
    </EvaluationPageLayout>
  )
}
