// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Eye, EyeOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { TopicVisibility } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

interface VisibilityBadgeProps {
  visibility: string
  showIcon?: boolean
}

export function VisibilityBadge({ visibility, showIcon = true }: VisibilityBadgeProps) {
  const { t } = useTranslation('evaluation')

  const isPublic = visibility === TopicVisibility.PUBLIC

  return (
    <Badge variant={isPublic ? 'info' : 'secondary'}>
      {showIcon &&
        (isPublic ? <Eye className="mr-1 h-3 w-3" /> : <EyeOff className="mr-1 h-3 w-3" />)}
      {t(`visibility.${visibility}`, visibility)}
    </Badge>
  )
}
