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
    const prefix = type === 'grading' ? 'grading.status' : `${type}.status`
    return t(`${prefix}.${status}`, String(status))
  }

  return <Badge variant={getVariant()}>{getLabel()}</Badge>
}
