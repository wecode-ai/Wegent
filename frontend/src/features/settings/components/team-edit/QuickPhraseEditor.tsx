// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'

const MAX_QUICK_PHRASES = 6
const MAX_QUICK_PHRASE_LENGTH = 120

interface QuickPhraseEditorProps {
  value: string[]
  onChange: (value: string[]) => void
  showLabel?: boolean
}

export default function QuickPhraseEditor({
  value,
  onChange,
  showLabel = false,
}: QuickPhraseEditorProps) {
  const { t } = useTranslation('settings')

  const updatePhrase = (index: number, phrase: string) => {
    const next = [...value]
    next[index] = phrase
    onChange(next)
  }

  const removePhrase = (index: number) => {
    onChange(value.filter((_, currentIndex) => currentIndex !== index))
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-3">
        {showLabel ? (
          <div>
            <div className="text-sm font-medium text-text-primary">
              {t('team.quick_phrases.label')}
            </div>
            <p className="mt-0.5 text-xs leading-[18px] text-text-muted">
              {t('team.quick_phrases.description')}
            </p>
          </div>
        ) : (
          <p className="text-xs leading-5 text-text-muted">{t('team.quick_phrases.description')}</p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2 text-primary hover:bg-primary/5 hover:text-primary"
          onClick={() => onChange([...value, ''])}
          disabled={value.length >= MAX_QUICK_PHRASES}
          data-testid="add-quick-phrase"
        >
          <Plus className="h-4 w-4" />
          {t('team.quick_phrases.add')}
        </Button>
      </div>
      <div className="space-y-2">
        {value.map((phrase, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={phrase}
              maxLength={MAX_QUICK_PHRASE_LENGTH}
              onChange={event => updatePhrase(index, event.target.value)}
              placeholder={t('team.quick_phrases.placeholder')}
              className="h-10 bg-base"
              data-testid={`quick-phrase-input-${index}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('common:actions.remove')}
              onClick={() => removePhrase(index)}
              className="h-10 min-w-10 shrink-0 rounded-md text-text-muted hover:text-text-primary"
              data-testid={`remove-quick-phrase-${index}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
