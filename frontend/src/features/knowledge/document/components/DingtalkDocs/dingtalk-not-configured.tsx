// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkNotConfigured - Shown when DingTalk MCP is not configured.
 *
 * Provides a link to the settings page for configuration.
 */

'use client'

import { Settings, FileText } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

export function DingtalkNotConfigured() {
  const { t } = useTranslation('knowledge')
  const router = useRouter()

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center text-center p-8"
      data-testid="dingtalk-not-configured"
    >
      <FileText className="w-16 h-16 text-text-muted mb-4" />
      <h3 className="text-lg font-medium text-text-primary mb-2">
        {t('document.dingtalk.notConfigured', '未配置钉钉文档')}
      </h3>
      <p className="text-sm text-text-muted max-w-md mb-6">
        {t(
          'document.dingtalk.configureHint',
          '请先在设置中启用并配置钉钉文档 MCP 服务，然后即可在此处浏览和同步钉钉文档。'
        )}
      </p>
      <Button
        variant="primary"
        onClick={() => router.push('/settings?section=integrations&tab=integrations')}
        className="h-11 min-w-[44px]"
        data-testid="dingtalk-go-to-settings-button"
      >
        <Settings className="w-4 h-4 mr-2" />
        {t('document.dingtalk.goToSettings', '前往设置')}
      </Button>
    </div>
  )
}
