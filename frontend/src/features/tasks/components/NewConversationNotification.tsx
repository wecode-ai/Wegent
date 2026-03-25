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
  }, [runtimeConfig.weiboAiToolboxMacDownloadUrl, runtimeConfig.weiboAiToolboxWindowsDownloadUrl])

  // Get markdown content from i18n and replace {{downloadUrl}} placeholder
  const content = useMemo(() => {
    const rawContent = t('new_conversation_notification.content', '')
    if (!rawContent || !downloadUrl) {
      return ''
    }
    return rawContent.replace(/\{\{downloadUrl\}\}/g, downloadUrl)
  }, [t, downloadUrl])

  if (!downloadUrl || !content) {
    return null
  }

  return (
    <NotificationBanner
      className={className}
      storageKey="newConversationNotificationClosed"
      content={content}
      actionLabel={t('new_conversation_notification.action')}
      actionHref={downloadUrl}
      reopenLabel={t('new_conversation_notification.reopen')}
      variant="info"
    />
  )
}
