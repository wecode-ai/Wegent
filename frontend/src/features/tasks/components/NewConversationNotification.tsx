// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import NotificationBanner from './NotificationBanner'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { getWeiboAiToolboxDownloadUrl } from '@/lib/weibo-ai-toolbox'

interface NewConversationNotificationProps {
  className?: string
}

export default function NewConversationNotification({
  className = '',
}: NewConversationNotificationProps) {
  const { t } = useTranslation('chat')
  const runtimeConfig = getRuntimeConfigSync()

  const downloadUrl = useMemo(() => {
    return getWeiboAiToolboxDownloadUrl(runtimeConfig)
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
