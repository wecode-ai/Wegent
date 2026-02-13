// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { createAuthorTopic } from '@wecode/api/evaluation-author'
import { TopicVisibility } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function NewTopicContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<string>(TopicVisibility.PRIVATE)

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

    setLoading(true)
    try {
      const topic = await createAuthorTopic({
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
      })
      toast({
        title: t('topics.created_success', 'Topic created successfully'),
        description: '',
      })
      router.push(`/evaluation/author/topics/${topic.id}`)
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

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      <Button variant="ghost" className="mb-6" onClick={() => router.back()}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('actions.back', 'Back')}
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>{t('topics.create', 'Create New Topic')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">{t('topics.name', 'Topic Name')} *</Label>
              <Input
                id="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('topics.name_placeholder', 'Enter topic name')}
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('topics.description', 'Description')}</Label>
              <Textarea
                id="description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('topics.description_placeholder', 'Enter topic description')}
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

            <div className="flex justify-end gap-4">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                {t('actions.cancel', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={loading}>
                {loading ? '...' : t('topics.create', 'Create Topic')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function NewTopicPage() {
  return (
    <EvaluationPageLayout>
      <NewTopicContent />
    </EvaluationPageLayout>
  )
}
