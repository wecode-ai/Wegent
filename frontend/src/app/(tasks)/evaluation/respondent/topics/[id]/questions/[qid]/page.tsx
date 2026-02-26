// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { respondentGetTopic, respondentListQuestions } from '@wecode/api/evaluation-respondent'
import { RespondentQuestion } from '@wecode/components/evaluation/respondent/components'
import type { Topic } from '@wecode/types/evaluation'

export default function RespondentQuestionPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [questionIds, setQuestionIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [topicData, questionsData] = await Promise.all([
          respondentGetTopic(topicId),
          respondentListQuestions(topicId, {}),
        ])
        setTopic(topicData)
        setQuestionIds(questionsData.items.map(q => q.id))
      } catch {
        toast({
          title: t('errors.load_failed'),
          description: t('errors.permission_denied'),
          variant: 'destructive',
        })
        router.push('/evaluation/respondent')
      } finally {
        setLoading(false)
      }
    }

    if (topicId) {
      loadData()
    }
  }, [topicId, toast, t, router])

  if (loading || !topic) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  const currentQuestionIndex = questionIds.findIndex(id => id === questionId)

  if (currentQuestionIndex === -1) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-text-muted">{t('errors.question_not_found')}</p>
      </div>
    )
  }

  // Use unified component - responsive layout handled internally
  return (
    <RespondentQuestion
      topic={topic}
      questionId={questionId}
      currentQuestionIndex={currentQuestionIndex}
      totalQuestions={questionIds.length}
      questionIds={questionIds}
    />
  )
}
