// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function ModelGroupIconLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('common')

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-2 px-3 text-xs text-text-secondary"
    >
      {t('models.group_icons_load_failed')}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 md:min-h-0"
        data-testid="model-group-icons-retry"
        onClick={onRetry}
      >
        {t('actions.retry')}
      </Button>
    </div>
  )
}
