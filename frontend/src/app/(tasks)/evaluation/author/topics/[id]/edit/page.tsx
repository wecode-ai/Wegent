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
import { useTranslation } from '@/hooks/useTranslation'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

function EditTopicContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<string>(TopicVisibility.PRIVATE)
  const [instructions, setInstructions] = useState('')
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const topicData = await getAuthorTopic(topicId)
      setTopic(topicData)
      setName(topicData.name)
      setDescription(topicData.description || '')
      setVisibility(topicData.visibility)
      setInstructions(topicData.extra_data?.instructions as string || '')
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

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
      await updateAuthorTopic(topicId, {
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
        instructions: instructions.trim() || undefined,
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
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!topic) {
    return null
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
          <CardTitle>{t('topics.edit', 'Edit Topic')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
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
              <p className="text-xs text-text-muted">
                {t('topics.instructions_hint')}
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
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? '...' : t('actions.save', 'Save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function EditTopicPage() {
  return (
    <EvaluationPageLayout>
      <EditTopicContent />
    </EvaluationPageLayout>
  )
}
