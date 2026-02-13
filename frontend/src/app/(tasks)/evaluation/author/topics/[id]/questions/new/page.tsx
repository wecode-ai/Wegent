// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
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
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { createAuthorQuestion, getAuthorTopic } from '@wecode/api/evaluation-author'
import { ContentType, type Topic } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function NewQuestionContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [loading, setLoading] = useState(false)
  const [topicLoading, setTopicLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [contentType, setContentType] = useState<string>(ContentType.TEXT)
  const [contentText, setContentText] = useState('')
  const [contentUrl, setContentUrl] = useState('')
  const [criteriaText, setCriteriaText] = useState('')

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

    setLoading(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (contentType === ContentType.TEXT || contentType === ContentType.MIXED) {
        contentData.text = contentText.trim()
      }
      if (contentType === ContentType.URL || contentType === ContentType.MIXED) {
        contentData.url = contentUrl.trim()
      }

      const criteriaData: Record<string, unknown> = {}
      if (criteriaText.trim()) {
        criteriaData.text = criteriaText.trim()
      }

      await createAuthorQuestion(topicId, {
        title: title.trim(),
        content_type: contentType,
        content_data: contentData,
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
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <div className="animate-pulse">
          <div className="mb-6 h-10 w-32 rounded bg-surface"></div>
          <div className="h-96 rounded bg-surface"></div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
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
                placeholder={t('questions.question_title', 'Question Title')}
                maxLength={500}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="contentType">{t('questions.content_type', 'Content Type')}</Label>
              <Select value={contentType} onValueChange={setContentType}>
                <SelectTrigger id="contentType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t('questions.content_types.text', 'Text')}</SelectItem>
                  <SelectItem value="url">{t('questions.content_types.url', 'URL')}</SelectItem>
                  <SelectItem value="attachment">
                    {t('questions.content_types.attachment', 'Attachment')}
                  </SelectItem>
                  <SelectItem value="mixed">
                    {t('questions.content_types.mixed', 'Mixed')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(contentType === ContentType.TEXT || contentType === ContentType.MIXED) && (
              <div className="space-y-2">
                <Label htmlFor="contentText">{t('questions.content', 'Content')}</Label>
                <Textarea
                  id="contentText"
                  value={contentText}
                  onChange={e => setContentText(e.target.value)}
                  placeholder={t('questions.content', 'Content')}
                  rows={6}
                />
              </div>
            )}

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

            <div className="space-y-2">
              <Label htmlFor="criteria">{t('questions.criteria', 'Grading Criteria')}</Label>
              <Textarea
                id="criteria"
                value={criteriaText}
                onChange={e => setCriteriaText(e.target.value)}
                placeholder={t('questions.criteria', 'Grading Criteria')}
                rows={4}
              />
              <p className="text-xs text-text-muted">
                {t('grading.description', 'Used for AI grading')}
              </p>
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
