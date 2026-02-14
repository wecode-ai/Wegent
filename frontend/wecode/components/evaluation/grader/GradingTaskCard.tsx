// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { FileText, User, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '../common/StatusBadge'
import type { GradingTask } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

interface GradingTaskCardProps {
  task: GradingTask
  basePath?: string
  onGrade?: (task: GradingTask) => void
}

/**
 * Grading task card component for displaying task overview.
 * Used in grader task lists.
 */
export function GradingTaskCard({
  task,
  basePath = '/evaluation/grader/answers',
  onGrade,
}: GradingTaskCardProps) {
  const router = useRouter()
  const { t } = useTranslation('evaluation')

  const handleClick = () => {
    router.push(`${basePath}/${task.answer_id}`)
  }

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary" onClick={handleClick}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">
              {task.question_title || `Question #${task.question_id}`}
            </CardTitle>
          </div>
          <StatusBadge status={task.status} type="grading" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
          {task.respondent_name && (
            <span className="flex items-center gap-1">
              <User className="h-4 w-4" />
              {task.respondent_name}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-4 w-4" />
            {new Date(task.created_at).toLocaleDateString()}
          </span>
        </div>
        {onGrade && (
          <Button
            variant="primary"
            size="sm"
            onClick={e => {
              e.stopPropagation()
              onGrade(task)
            }}
          >
            {t('grading.grade', 'Grade')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
