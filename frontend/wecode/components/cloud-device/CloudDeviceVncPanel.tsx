// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ComputerDesktopIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import '@wecode/i18n'

interface CloudDeviceVncPanelProps {
  readonly vncUrl: string
  readonly deviceName?: string
}

export function CloudDeviceVncPanel({ vncUrl, deviceName }: CloudDeviceVncPanelProps) {
  const { t } = useTranslation('devices')

  return (
    <a
      href={vncUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary border border-primary/30 rounded-md hover:bg-primary/10 transition-colors"
      title={deviceName || t('vnc_title')}
    >
      <ComputerDesktopIcon className="h-4 w-4" />
      <span>{t('vnc_open_desktop')}</span>
      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
    </a>
  )
}

export default CloudDeviceVncPanel
