// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'

interface AdvancedKnowledgeToggleProps {
  checked: boolean
  onCheckedChange: (show: boolean) => void
  id: string
  testId: string
}

export function AdvancedKnowledgeToggle({
  checked,
  onCheckedChange,
  id,
  testId,
}: AdvancedKnowledgeToggleProps) {
  const { t } = useTranslation('knowledge')

  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-text-secondary hover:bg-hover"
      title={t('document.knowledgeBase.advancedModeDescription')}
    >
      <Switch id={id} data-testid={testId} checked={checked} onCheckedChange={onCheckedChange} />
      <span>{t('document.knowledgeBase.advancedMode')}</span>
    </label>
  )
}
