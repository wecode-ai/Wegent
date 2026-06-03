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
}

export default function QuickPhraseEditor({ value, onChange }: QuickPhraseEditorProps) {
  const { t } = useTranslation('settings')
  const rows = value.length > 0 ? value : ['']

  const updatePhrase = (index: number, phrase: string) => {
    const next = [...rows]
    next[index] = phrase
    onChange(next)
  }

  const removePhrase = (index: number) => {
    onChange(value.filter((_, currentIndex) => currentIndex !== index))
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {rows.map((phrase, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={phrase}
              maxLength={MAX_QUICK_PHRASE_LENGTH}
              onChange={event => updatePhrase(index, event.target.value)}
              placeholder={t('team.quick_phrases.placeholder')}
              className="h-9 bg-base"
              data-testid={`quick-phrase-input-${index}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('common:actions.remove')}
              onClick={() => removePhrase(index)}
              className="h-11 min-w-[44px] shrink-0 rounded-md text-text-muted hover:text-text-primary"
              data-testid={`remove-quick-phrase-${index}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 min-w-[44px]"
        onClick={() => onChange([...value, ''])}
        disabled={value.length >= MAX_QUICK_PHRASES}
        data-testid="add-quick-phrase"
      >
        <Plus className="h-4 w-4" />
        {t('team.quick_phrases.add')}
      </Button>
    </div>
  )
}
