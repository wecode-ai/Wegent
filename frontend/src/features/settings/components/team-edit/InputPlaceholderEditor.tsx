// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { ChevronDown, Languages, Monitor, Smartphone } from 'lucide-react'

import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { LocalizedInputPlaceholder, TeamInputPlaceholder } from '@/types/api'

interface InputPlaceholderEditorProps {
  value: TeamInputPlaceholder
  onChange: (value: TeamInputPlaceholder) => void
}

type DeviceKey = 'mobile' | 'desktop'
type PlaceholderScope = 'generic' | DeviceKey
type LocaleKey = 'zh' | 'en'

export function normalizeInputPlaceholder(
  value: TeamInputPlaceholder
): TeamInputPlaceholder | null {
  const normalizeLocalized = (
    localized: LocalizedInputPlaceholder | null | undefined
  ): LocalizedInputPlaceholder | null => {
    const zh = localized?.zh?.trim()
    const en = localized?.en?.trim()
    return zh || en ? { ...(zh && { zh }), ...(en && { en }) } : null
  }

  const generic = normalizeLocalized(value)
  const desktop = normalizeLocalized(value.desktop)
  const mobile = normalizeLocalized(value.mobile)

  if (!generic && !desktop && !mobile) return null

  return {
    ...generic,
    ...(desktop && { desktop }),
    ...(mobile && { mobile }),
  }
}

export default function InputPlaceholderEditor({ value, onChange }: InputPlaceholderEditorProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [activeScope, setActiveScope] = useState<PlaceholderScope>('generic')

  const updateGeneric = (locale: LocaleKey, text: string) => {
    onChange({ ...value, [locale]: text })
  }

  const updateDevice = (device: DeviceKey, locale: LocaleKey, text: string) => {
    onChange({
      ...value,
      [device]: {
        ...value[device],
        [locale]: text,
      },
    })
  }

  const scopes = [
    { key: 'generic' as const, icon: Languages },
    { key: 'desktop' as const, icon: Monitor },
    { key: 'mobile' as const, icon: Smartphone },
  ]
  const activeValue = activeScope === 'generic' ? value : value[activeScope]

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setIsExpanded(current => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-accent"
        aria-expanded={isExpanded}
        data-testid="team-input-placeholder-toggle"
      >
        <span className="text-xs leading-5 text-text-muted">
          {t('settings:team.input_placeholder.description')}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-text-muted transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <>
          <div className="inline-flex h-9 w-fit items-center rounded-md bg-surface p-1">
            {scopes.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveScope(key)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
                  activeScope === key
                    ? 'bg-base text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                )}
                aria-pressed={activeScope === key}
                data-testid={`team-input-placeholder-scope-${key}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(`settings:team.input_placeholder.${key}`)}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {(['zh', 'en'] as const).map(locale => (
              <div key={locale} className="space-y-1.5">
                <div className="text-xs font-medium text-text-secondary">
                  {t(`settings:team.input_placeholder.${locale}`)}
                </div>
                <Textarea
                  value={activeValue?.[locale] || ''}
                  onChange={event =>
                    activeScope === 'generic'
                      ? updateGeneric(locale, event.target.value)
                      : updateDevice(activeScope, locale, event.target.value)
                  }
                  placeholder={t(`settings:team.input_placeholder.${locale}_placeholder`)}
                  className="min-h-[76px] resize-y bg-base text-sm"
                  data-testid={`team-input-placeholder-${activeScope}-${locale}`}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
