// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import GitHubIntegration from '@/features/settings/components/GitHubIntegration'
import { EmailTokenSection } from '@wecode/components/settings/EmailTokenSection'

/**
 * Integrations settings page that combines Git token management
 * and company email token configuration.
 */
export function IntegrationsPage() {
  return (
    <div className="space-y-8">
      <GitHubIntegration />
      <EmailTokenSection />
    </div>
  )
}
