// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Switch } from '@/components/ui/switch'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { useTranslation } from '@/hooks/useTranslation'

export function DingtalkAutoSyncSetting({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const { t } = useTranslation('knowledge')

  return (
    <SimpleConfigRow
      label={t('document.dingtalkAutoSync.label')}
      description={t('document.dingtalkAutoSync.description')}
    >
      <div className="flex min-h-11 items-center justify-end">
        <Switch
          id="knowledge-dingtalk-auto-sync"
          aria-label={t('document.dingtalkAutoSync.label')}
          data-testid="knowledge-dingtalk-auto-sync"
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </SimpleConfigRow>
  )
}
