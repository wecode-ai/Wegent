// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import GitHubIntegration from './GitHubIntegration'
import McpProviderIntegrations from './McpProviderIntegrations'

export default function IntegrationsPage() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('common:integrations.title')}
        </h2>
        <p className="text-sm text-text-muted mb-1">{t('common:integrations.description')}</p>
      </div>

      {/* Git integration section */}
      <GitHubIntegration />

      <McpProviderIntegrations providerId="dingtalk" />
    </div>
  )
}
