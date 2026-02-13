// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, History, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { getAuthorTopic, listAuthorTopicVersions } from '@wecode/api/evaluation-author'
import type { Topic, TopicVersion } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function VersionsContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [versions, setVersions] = useState<TopicVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, versionsData] = await Promise.all([
        getAuthorTopic(topicId),
        listAuthorTopicVersions(topicId, { page, limit: 20 }),
      ])

      setTopic(topicData)
      setVersions(versionsData.items)
      setTotal(versionsData.total)
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
  }, [topicId, page, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

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
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back', 'Back')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('topics.version_history', 'Version History')}
          </CardTitle>
          <CardDescription>
            {t(
              'topics.version_description',
              'Published versions of this topic and their question snapshots'
            )}{' '}
            - {topic.name}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <div className="py-8 text-center">
              <History className="mx-auto mb-4 h-12 w-12 text-text-muted" />
              <p className="text-text-secondary">
                {t('topics.no_versions', 'No published versions yet')}
              </p>
              <p className="mt-2 text-sm text-text-muted">
                {t(
                  'topics.no_versions_description',
                  'Publish your topic to create the first version'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <Accordion type="single" collapsible className="w-full">
                {versions.map((version, index) => (
                  <AccordionItem key={version.id} value={`version-${version.id}`}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center gap-4">
                        <Badge variant={index === 0 ? 'default' : 'secondary'}>
                          v{version.version}
                        </Badge>
                        <span className="text-sm text-text-secondary">
                          {new Date(version.published_at).toLocaleString()}
                        </span>
                        <span className="text-sm text-text-muted">
                          {version.question_snapshots?.length || 0}{' '}
                          {t('questions.title', 'questions')}
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-2 pl-4">
                        {version.question_snapshots && version.question_snapshots.length > 0 ? (
                          version.question_snapshots.map((snapshot, qIndex) => (
                            <div
                              key={snapshot.question_id}
                              className="flex items-center gap-3 rounded-lg bg-surface p-3"
                            >
                              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-base text-xs font-medium">
                                {qIndex + 1}
                              </span>
                              <div className="flex-1">
                                <div className="font-medium">{snapshot.title}</div>
                                <div className="text-xs text-text-muted">
                                  v{snapshot.version} | ID: {snapshot.question_id}
                                </div>
                              </div>
                              <FileText className="h-4 w-4 text-text-muted" />
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-text-muted">
                            {t('questions.no_questions', 'No questions in this version')}
                          </p>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {/* Pagination */}
              {total > 20 && (
                <div className="mt-6 flex justify-center gap-2">
                  <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    {t('common:previous', 'Previous')}
                  </Button>
                  <span className="flex items-center px-4 text-sm text-text-secondary">
                    {t('common:page', 'Page')} {page} / {Math.ceil(total / 20)}
                  </span>
                  <Button
                    variant="outline"
                    disabled={page >= Math.ceil(total / 20)}
                    onClick={() => setPage(page + 1)}
                  >
                    {t('common:next', 'Next')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function VersionsPage() {
  return (
    <EvaluationPageLayout>
      <VersionsContent />
    </EvaluationPageLayout>
  )
}
