// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { RefreshCw } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { TriggerRunForm } from './TriggerRunForm'
import { RunList } from './RunList'

export function StatRunsPanel() {
  return (
    <div className="space-y-6" data-testid="stat-runs-panel">
      <TriggerRunForm />

      <hr className="border-border" />

      <RunListHeader />
      <RunList />
    </div>
  )
}

function RunListHeader() {
  const { t } = useTranslation('knowledge-stat')
  // Access refresh from RunList context isn't straightforward,
  // so we use a custom event to trigger refresh
  const handleRefresh = () => {
    window.dispatchEvent(new CustomEvent('kb-stat:refresh-runs'))
  }

  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-base font-semibold text-text-primary">{t('runs.list.title')}</h2>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRefresh}
        className="h-7 px-2 text-text-muted hover:text-text-primary"
        data-testid="refresh-runs"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
