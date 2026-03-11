// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import NotificationBanner from './NotificationBanner'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

interface NewConversationNotificationProps {
  className?: string
}

export default function NewConversationNotification({
  className = '',
}: NewConversationNotificationProps) {
  const { t } = useTranslation('chat')
  const runtimeConfig = getRuntimeConfigSync()

  const downloadUrl = useMemo(() => {
    const macUrl = runtimeConfig.weiboAiToolboxMacDownloadUrl
    const windowsUrl = runtimeConfig.weiboAiToolboxWindowsDownloadUrl

    if (typeof navigator === 'undefined') {
      return macUrl || windowsUrl
    }

    const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
    const isWindows = platform.includes('win')
    const isApple = /mac|iphone|ipad|ipod/.test(platform)

    if (isWindows) {
      return windowsUrl || macUrl
    }

    if (isApple) {
      return macUrl || windowsUrl
    }

    return macUrl || windowsUrl
  }, [
    runtimeConfig.weiboAiToolboxMacDownloadUrl,
    runtimeConfig.weiboAiToolboxWindowsDownloadUrl,
  ])

  if (!downloadUrl) {
    return null
  }

  return (
    <NotificationBanner
      className={className}
      storageKey="newConversationNotificationClosed"
      title={t('new_conversation_notification.title')}
      actionLabel={t('new_conversation_notification.action')}
      actionHref={downloadUrl}
      reopenLabel={t('new_conversation_notification.reopen')}
      variant="info"
    />
  )
}
