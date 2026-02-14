// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { TopicStatus, GradingTaskStatus } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

type StatusType = 'topic' | 'question' | 'grading'

interface StatusBadgeProps {
  status: number | string
  type: StatusType
}

export function StatusBadge({ status, type }: StatusBadgeProps) {
  const { t } = useTranslation('evaluation')

  const getVariant = () => {
    // Convert to number for comparison
    const numStatus = typeof status === 'string' ? parseInt(status, 10) : status

    switch (numStatus) {
      case TopicStatus.PUBLISHED:
      case GradingTaskStatus.PUBLISHED:
      case GradingTaskStatus.COMPLETED:
        return 'success'
      case TopicStatus.DRAFT:
      case GradingTaskStatus.PENDING:
        return 'secondary'
      case GradingTaskStatus.RUNNING:
        return 'info'
      case GradingTaskStatus.FAILED:
        return 'error'
      default:
        return 'secondary'
    }
  }

  const getLabel = () => {
    const numStatus = typeof status === 'string' ? parseInt(status, 10) : status

    // Map status codes to translation keys
    if (type === 'grading') {
      // Grading task status: pending=0, running=1, completed=2, failed=3, published=4
      const statusMap: Record<number, string> = {
        [GradingTaskStatus.PENDING]: 'pending',
        [GradingTaskStatus.RUNNING]: 'running',
        [GradingTaskStatus.COMPLETED]: 'completed',
        [GradingTaskStatus.FAILED]: 'failed',
        [GradingTaskStatus.PUBLISHED]: 'published',
      }
      const key = statusMap[numStatus] || String(numStatus)
      return t(`grading.status.${key}`)
    } else {
      // Topic/Question status: draft=0, published=1
      const statusMap: Record<number, string> = {
        [TopicStatus.DRAFT]: 'unpublished',
        [TopicStatus.PUBLISHED]: 'published',
      }
      const key = statusMap[numStatus] || String(numStatus)
      return t(`topics.${key}`)
    }
  }

  return <Badge variant={getVariant()}>{getLabel()}</Badge>
}
