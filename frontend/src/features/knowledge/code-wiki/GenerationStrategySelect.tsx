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

interface GenerationStrategySelectProps {
  value?: string | null
  onChange: (strategyId: string) => void
  /** What an empty selection resolves to in this particular form. */
  emptyOption?: 'deployment' | 'wiki'
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

  useEffect(() => {
    let active = true
    void codeWikiApi
      .strategies()
      .then(next => {
        if (active) setCapabilities(next)
      })
      .catch(() => {
        if (active) setCapabilities({ default_strategy: null, strategies: [] })
      })
    return () => {
      active = false
    }
  }, [])

  const choices = capabilities?.strategies ?? []
  const selected = value || (emptyOption ? DEFAULT_OPTION : '')
  const legacy = Boolean(value && !choices.some(item => item.id === value))
  const disabled = capabilities === null || choices.length === 0
  const deploymentDefaultDescription = capabilities?.default_strategy
    ? t('codeWiki.strategy.deploymentDefaultNamed', {
        strategy:
          choices.find(item => item.id === capabilities.default_strategy)?.display_name ?? '',
      })
    : t('codeWiki.strategy.deploymentDefaultLegacy')

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
          <SelectValue placeholder={t('codeWiki.strategy.loading')} />
        </SelectTrigger>
        <SelectContent>
          {emptyOption && (
            <SelectItem value={DEFAULT_OPTION}>
              {t(
                emptyOption === 'deployment'
                  ? 'codeWiki.strategy.deploymentDefault'
                  : 'codeWiki.strategy.wikiDefault'
              )}
            </SelectItem>
          )}
          {legacy && (
            <SelectItem value={value!} disabled>
              {t(value === 'legacy' ? 'codeWiki.strategy.legacy' : 'codeWiki.strategy.unavailable')}
            </SelectItem>
          )}
          {choices.map(option => (
            <SelectItem key={option.id} value={option.id}>
              {option.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {emptyOption && selected === DEFAULT_OPTION ? (
        <p className="text-xs text-text-muted">
          {emptyOption === 'deployment'
            ? deploymentDefaultDescription
            : t('codeWiki.strategy.wikiDefaultDescription')}
        </p>
      ) : (
        choices
          .filter(option => option.id === selected)
          .map(option => (
            <p key={option.id} className="text-xs text-text-muted">
              {option.description}
            </p>
          ))
      )}
    </div>
  )
}
