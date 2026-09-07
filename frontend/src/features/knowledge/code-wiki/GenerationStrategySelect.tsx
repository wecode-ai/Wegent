// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { codeWikiApi } from '@/apis/code-wiki'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeWikiGenerationStrategyCapabilities } from '@/types/code-wiki'

const DEFAULT_OPTION = '__generation_strategy_default__'
const BUILTIN_STRATEGY_IDS = new Set([
  'coordinator_adaptive',
  'coordinator_reviewed',
  'coordinator_solo',
])

interface GenerationStrategySelectProps {
  value?: string | null
  onChange: (strategyId: string) => void
  /** What an empty selection resolves to in this particular form. */
  emptyOption?: 'deployment'
  testId: string
}

/**
 * One small UI seam for both creation and Wiki settings.
 *
 * The server returns only configured, runnable strategies. Team names and policy
 * structure remain deployment concerns, never a frontend mapping table.
 */
export function GenerationStrategySelect({
  value,
  onChange,
  emptyOption,
  testId,
}: GenerationStrategySelectProps) {
  const { t } = useTranslation('knowledge')
  const [capabilities, setCapabilities] = useState<CodeWikiGenerationStrategyCapabilities | null>(
    null
  )
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    void codeWikiApi
      .strategies()
      .then(next => {
        if (active) {
          setCapabilities(next)
          setLoadState('ready')
        }
      })
      .catch(() => {
        if (active) setLoadState('error')
      })
    return () => {
      active = false
    }
  }, [])

  const choices = capabilities?.strategies ?? []
  const selected = value || (emptyOption ? DEFAULT_OPTION : '')
  const legacy = Boolean(value && !choices.some(item => item.id === value))
  const disabled = loadState !== 'ready' || choices.length === 0
  const optionFor = (id: string) => choices.find(item => item.id === id)
  const displayName = (id: string, fallback: string) =>
    BUILTIN_STRATEGY_IDS.has(id) ? t(`codeWiki.strategy.options.${id}.title`) : fallback
  const description = (id: string, fallback: string) =>
    BUILTIN_STRATEGY_IDS.has(id) ? t(`codeWiki.strategy.options.${id}.description`) : fallback
  const defaultId = capabilities?.default_strategy ?? 'legacy'
  const defaultOption = optionFor(defaultId)
  const defaultName =
    defaultId === 'legacy'
      ? t('codeWiki.strategy.legacyTitle')
      : displayName(defaultId, defaultOption?.display_name ?? defaultId)
  const currentOption = optionFor(selected)
  const triggerLabel =
    loadState === 'loading'
      ? t('codeWiki.strategy.loading')
      : loadState === 'error'
        ? t('codeWiki.strategy.loadFailed')
        : choices.length === 0
          ? t('codeWiki.strategy.noneAvailable')
          : selected === DEFAULT_OPTION
            ? t('codeWiki.strategy.systemRecommended', { strategy: defaultName })
            : currentOption
              ? displayName(currentOption.id, currentOption.display_name)
              : legacy
                ? t(
                    value === 'legacy'
                      ? 'codeWiki.strategy.legacyTitle'
                      : 'codeWiki.strategy.unavailable'
                  )
                : t('codeWiki.strategy.systemRecommended', { strategy: defaultName })

  return (
    <div className="space-y-1.5">
      <Select
        value={selected}
        onValueChange={next => onChange(next === DEFAULT_OPTION ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger
          className="bg-base"
          data-testid={testId}
          aria-label={t('codeWiki.strategy.label')}
        >
          <SelectValue>{triggerLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {emptyOption && (
            <SelectItem value={DEFAULT_OPTION}>
              {t('codeWiki.strategy.systemRecommended', { strategy: defaultName })}
            </SelectItem>
          )}
          {legacy && (
            <SelectItem value={value!} disabled>
              {t(
                value === 'legacy'
                  ? 'codeWiki.strategy.legacyTitle'
                  : 'codeWiki.strategy.unavailable'
              )}
            </SelectItem>
          )}
          {choices.map(option => (
            <SelectItem key={option.id} value={option.id}>
              {displayName(option.id, option.display_name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {emptyOption && selected === DEFAULT_OPTION ? (
        <p className="text-xs text-text-muted">
          {defaultId === 'legacy'
            ? t('codeWiki.strategy.legacyDescription')
            : t('codeWiki.strategy.systemRecommendedDescription', { strategy: defaultName })}
        </p>
      ) : (
        choices
          .filter(option => option.id === selected)
          .map(option => (
            <p key={option.id} className="text-xs text-text-muted">
              {description(option.id, option.description)}
            </p>
          ))
      )}
    </div>
  )
}
