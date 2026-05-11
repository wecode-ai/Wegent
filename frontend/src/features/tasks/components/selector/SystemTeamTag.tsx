// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Tag } from '@/components/ui/tag'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface SystemTeamTagProps {
  className?: string
}

export default function SystemTeamTag({ className }: SystemTeamTagProps) {
  const { t } = useTranslation()

  return (
    <Tag className={cn('text-xs !m-0 flex-shrink-0', className)} variant="info">
      {t('common:teams.system', '系统')}
    </Tag>
  )
}
