// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { BookOpen, Check, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DocumentViewType } from '@/types/knowledge'

const options = [
  { value: 'notebook', label: 'typeNotebook', description: 'notebookDesc', icon: BookOpen },
  { value: 'classic', label: 'typeClassic', description: 'classicDesc', icon: Database },
] as const

export function KnowledgeBaseDefaultViewSetting({
  value,
  onSelect,
  changeTestId,
}: {
  value: DocumentViewType
  onSelect: (value: DocumentViewType) => void
  changeTestId: string
}) {
  const { t } = useTranslation('knowledge')
  const groupLabel = t('document.knowledgeBase.type')

  return (
    <SimpleConfigRow label={groupLabel} align="start">
      <div role="group" aria-label={groupLabel} className="grid min-w-0 gap-2 lg:grid-cols-2">
        {options.map(({ value: option, label, description, icon: Icon }) => {
          const selected = value === option
          return (
            <Button
              key={option}
              type="button"
              variant="outline"
              aria-pressed={selected}
              data-testid={selected ? 'kb-default-view-current' : changeTestId}
              onClick={selected ? undefined : () => onSelect(option)}
              className={cn(
                'h-auto min-h-11 min-w-0 items-start justify-start gap-2 whitespace-normal px-3 py-3 text-left',
                selected && 'border-primary/40 bg-primary/5 hover:bg-primary/5'
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn('mt-0.5 h-4 w-4 shrink-0', selected && 'text-primary')}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t(`document.knowledgeBase.${label}`)}</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-text-secondary">
                  {t(`document.knowledgeBase.${description}`)}
                </span>
              </span>
              {selected && (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              )}
            </Button>
          )
        })}
      </div>
    </SimpleConfigRow>
  )
}
