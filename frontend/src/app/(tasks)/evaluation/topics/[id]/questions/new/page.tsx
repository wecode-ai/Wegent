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
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import { createQuestion, getTopic } from '@wecode/api/evaluation'
import { ContentType, type Topic } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

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
      const topicData = await getTopic(topicId)
      setTopic(topicData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/topics')
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

      await createQuestion(topicId, {
        title: title.trim(),
        content_type: contentType,
        content_data: contentData,
        criteria_data: Object.keys(criteriaData).length > 0 ? criteriaData : undefined,
      })

      toast({
        title: t('questions.created_success'),
        description: '',
      })
      router.push(`/evaluation/topics/${topicId}`)
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
        onClick={() => router.push(`/evaluation/topics/${topicId}`)}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('actions.back')}
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>{t('questions.create')}</CardTitle>
          {topic && (
            <p className="text-sm text-text-secondary">
              {t('topics.title')}: {topic.name}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="title">{t('questions.question_title')} *</Label>
              <Input
                id="title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder={t('questions.question_title')}
                maxLength={500}
              />
            </div>

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

            {(contentType === ContentType.TEXT || contentType === ContentType.MIXED) && (
              <div className="space-y-2">
                <Label htmlFor="contentText">{t('questions.content')}</Label>
                <Textarea
                  id="contentText"
                  value={contentText}
                  onChange={e => setContentText(e.target.value)}
                  placeholder={t('questions.content')}
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
              <Label htmlFor="criteria">{t('questions.criteria')}</Label>
              <Textarea
                id="criteria"
                value={criteriaText}
                onChange={e => setCriteriaText(e.target.value)}
                placeholder={t('questions.criteria')}
                rows={4}
              />
              <p className="text-xs text-text-muted">{t('grading.description')}</p>
            </div>

            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/evaluation/topics/${topicId}`)}
              >
                {t('actions.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={loading}>
                {loading ? '...' : t('actions.save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function NewQuestionPage() {
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
        <NewQuestionContent />
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
          <NewQuestionContent />
        </main>
      </div>
    </div>
  )
}
