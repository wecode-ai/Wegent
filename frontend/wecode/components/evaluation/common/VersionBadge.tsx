// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'

interface VersionBadgeProps {
  version: number
  isCurrent?: boolean
}

export function VersionBadge({ version, isCurrent = false }: VersionBadgeProps) {
  const { t } = useTranslation('evaluation')

  return (
    <Badge variant={isCurrent ? 'success' : 'secondary'}>
      v{version}
      {isCurrent && ` (${t('versions.current', 'Current')})`}
    </Badge>
  )
}
