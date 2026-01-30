// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { VersionStatus } from '@/apis/devices'
import { Check, AlertTriangle, XCircle } from 'lucide-react'

interface ExecutorVersionBadgeProps {
  version?: string
  versionStatus?: VersionStatus
  showVersion?: boolean
}

/**
 * Badge component showing executor version status with icon and text.
 */
export function ExecutorVersionBadge({
  version,
  versionStatus,
  showVersion = true,
}: ExecutorVersionBadgeProps) {
  const { t } = useTranslation('devices')

  if (!version) {
    return null
  }

  const getStatusConfig = () => {
    switch (versionStatus) {
      case 'up_to_date':
        return {
          icon: Check,
          text: t('version_up_to_date'),
          className: 'bg-green-100 text-green-700 hover:bg-green-100',
        }
      case 'update_available':
        return {
          icon: AlertTriangle,
          text: t('version_update_available'),
          className: 'bg-orange-100 text-orange-700 hover:bg-orange-100',
        }
      case 'incompatible':
        return {
          icon: XCircle,
          text: t('version_incompatible'),
          className: 'bg-red-100 text-red-700 hover:bg-red-100',
        }
      default:
        return {
          icon: Check,
          text: t('version_up_to_date'),
          className: 'bg-gray-100 text-gray-700 hover:bg-gray-100',
        }
    }
  }

  const config = getStatusConfig()
  const Icon = config.icon

  return (
    <Badge variant="outline" className={config.className}>
      <Icon className="mr-1 h-3 w-3" />
      {showVersion && <span className="mr-1">v{version}</span>}
      {config.text}
    </Badge>
  )
}
