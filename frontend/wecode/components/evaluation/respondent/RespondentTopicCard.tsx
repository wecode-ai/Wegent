// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { BookOpen, FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import type { Topic } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

interface RespondentTopicCardProps {
  topic: Topic
  basePath?: string
  progress?: {
    answered: number
    total: number
  }
}

/**
 * Topic card component for respondent view.
 * Shows topic with answer progress.
 */
export function RespondentTopicCard({
  topic,
  basePath = '/evaluation/respondent/topics',
  progress,
}: RespondentTopicCardProps) {
  const router = useRouter()
  const { t } = useTranslation('evaluation')

  const handleClick = () => {
    router.push(`${basePath}/${topic.id}`)
  }

  const progressPercent = progress ? Math.round((progress.answered / progress.total) * 100) : 0

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary" onClick={handleClick}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{topic.name}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {topic.description && (
          <p className="mb-3 line-clamp-2 text-sm text-text-secondary">{topic.description}</p>
        )}

        {progress && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-text-secondary">{t('answers.progress.title', 'Progress')}</span>
              <span className="text-text-primary">
                {progress.answered}/{progress.total} ({progressPercent}%)
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <span className="flex items-center gap-1">
            <FileText className="h-4 w-4" />
            {topic.question_count || 0} {t('questions.title', 'Questions')}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
