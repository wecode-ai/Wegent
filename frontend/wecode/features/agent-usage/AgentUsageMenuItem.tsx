// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'

export function AgentUsageMenuItem({ onNavigate }: { onNavigate: () => void }) {
  const router = useRouter()
  const { t } = useTranslation('wecode')

  return (
    <button
      type="button"
      role="menuitem"
      data-testid="agent-usage-menu-item"
      onClick={() => {
        router.push('/agent-usage')
        onNavigate()
      }}
      className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
    >
      <ChartBarIcon className="w-4 h-4 text-text-muted" />
      {t('agent_usage.title')}
    </button>
  )
}
