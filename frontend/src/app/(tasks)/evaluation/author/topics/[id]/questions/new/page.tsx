// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { createAuthorQuestion, getAuthorTopic } from '@wecode/api/evaluation-author'
import { ContentType, type Topic } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function NewQuestionContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [loading, setLoading] = useState(false)
  const [topicLoading, setTopicLoading] = useState(true)
  const [title, setTitle] = useState('')
  // Question content is Markdown only
  const [contentText, setContentText] = useState('')
  const [showContentPreview, setShowContentPreview] = useState(false)
  // Criteria is also Markdown only
  const [criteriaText, setCriteriaText] = useState('')
  const [showCriteriaPreview, setShowCriteriaPreview] = useState(false)

  const loadTopic = useCallback(async () => {
    setTopicLoading(true)
    try {
      const topicData = await getAuthorTopic(topicId)
      setTopic(topicData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/author')
    } finally {
      setTopicLoading(false)
    }
  }, [topicId, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadTopic()
    }
  }, [topicId, loadTopic])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!title.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.question_title') + ' is required',
        variant: 'destructive',
      })
      return
    }

    if (!contentText.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('questions.content') + ' is required',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      // Content is always text/Markdown only
      const contentData: Record<string, unknown> = {
        text: contentText.trim(),
      }

      // Criteria is also text/Markdown only
      const criteriaData: Record<string, unknown> = {}
      if (criteriaText.trim()) {
        criteriaData.text = criteriaText.trim()
      }

      await createAuthorQuestion(topicId, {
        title: title.trim(),
        content_type: ContentType.TEXT,
        content_data: contentData,
        criteria_type: ContentType.TEXT,
        criteria_data: Object.keys(criteriaData).length > 0 ? criteriaData : undefined,
      })

      toast({
        title: t('questions.created_success', 'Question created successfully'),
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
      setLoading(false)
    }
  }

  if (topicLoading) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="animate-pulse">
          <div className="mb-6 h-10 w-32 rounded bg-surface"></div>
          <div className="h-96 rounded bg-surface"></div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
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
          <CardTitle>{t('questions.create', 'Create Question')}</CardTitle>
          {topic && (
            <p className="text-sm text-text-secondary">
              {t('topics.title', 'Topic')}: {topic.name}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="title">{t('questions.question_title', 'Question Title')} *</Label>
              <Input
                id="title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder={t('questions.title_placeholder', 'Enter question title')}
                maxLength={500}
              />
            </div>

            {/* Question Content - Markdown with Preview */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="contentText">
                  {t('questions.content', 'Content')} * (Markdown)
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowContentPreview(!showContentPreview)}
                >
                  {showContentPreview ? (
                    <>
                      <EyeOff className="mr-1 h-4 w-4" />
                      {t('actions.edit', 'Edit')}
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
                    <p className="text-text-muted">{t('questions.no_content', 'No content')}</p>
                  )}
                </div>
              ) : (
                <Textarea
                  id="contentText"
                  value={contentText}
                  onChange={e => setContentText(e.target.value)}
                  placeholder={t(
                    'questions.content_placeholder',
                    'Enter question content in Markdown format'
                  )}
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

            {/* Grading Criteria - Markdown with Preview */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="criteria">
                  {t('questions.criteria', 'Grading Criteria')} (Markdown)
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCriteriaPreview(!showCriteriaPreview)}
                >
                  {showCriteriaPreview ? (
                    <>
                      <EyeOff className="mr-1 h-4 w-4" />
                      {t('actions.edit', 'Edit')}
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
                    <p className="text-text-muted">
                      {t('questions.no_criteria', 'No grading criteria')}
                    </p>
                  )}
                </div>
              ) : (
                <Textarea
                  id="criteria"
                  value={criteriaText}
                  onChange={e => setCriteriaText(e.target.value)}
                  placeholder={t(
                    'questions.criteria_placeholder',
                    'Enter grading criteria in Markdown format'
                  )}
                  rows={6}
                  className="font-mono text-sm"
                />
              )}
              <p className="text-xs text-text-muted">{t('grading.description')}</p>
            </div>

            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
              >
                {t('actions.cancel', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={loading}>
                {loading ? '...' : t('actions.save', 'Save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function NewQuestionPage() {
  return (
    <EvaluationPageLayout>
      <NewQuestionContent />
    </EvaluationPageLayout>
  )
}
