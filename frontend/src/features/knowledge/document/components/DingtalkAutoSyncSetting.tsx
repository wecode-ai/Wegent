// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Switch } from '@/components/ui/switch'
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
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <label
          htmlFor="knowledge-dingtalk-auto-sync"
          className="text-sm font-medium text-text-primary"
        >
          {t('document.dingtalkAutoSync.label')}
        </label>
        <p className="text-xs leading-5 text-text-muted">
          {t('document.dingtalkAutoSync.description')}
        </p>
      </div>
      <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
        <Switch
          id="knowledge-dingtalk-auto-sync"
          aria-label={t('document.dingtalkAutoSync.label')}
          data-testid="knowledge-dingtalk-auto-sync"
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </label>
    </div>
  )
}
