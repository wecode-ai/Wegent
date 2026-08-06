// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import type { MarketplaceExampleConversation } from '../types'

const MAX_EXAMPLE_CONVERSATIONS = 10

interface ExampleConversationsEditorProps {
  value: MarketplaceExampleConversation[]
  onChange: (value: MarketplaceExampleConversation[]) => void
  testIdPrefix: string
}

export function ExampleConversationsEditor({
  value,
  onChange,
  testIdPrefix,
}: ExampleConversationsEditorProps) {
  const { t } = useTranslation('resource-library')

  const updateItem = (
    index: number,
    field: keyof MarketplaceExampleConversation,
    fieldValue: string
  ) => {
    onChange(
      value.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: fieldValue } : item
      )
    )
  }

  return (
    <div className="space-y-3" data-testid={`${testIdPrefix}-editor`}>
      <div>
        <Label>{t('fields.example_conversations')}</Label>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t('fields.example_conversation_publisher_description')}
        </p>
      </div>

      {value.map((item, index) => (
        <div
          key={index}
          className="grid gap-2 rounded-lg border border-border bg-base p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
          data-testid={`${testIdPrefix}-item-${index}`}
        >
          <Input
            value={item.title}
            onChange={event => updateItem(index, 'title', event.target.value)}
            placeholder={t('fields.example_conversation_title_placeholder')}
            aria-label={t('fields.example_conversation_title')}
            data-testid={`${testIdPrefix}-title-${index}`}
          />
          <Input
            type="url"
            value={item.url}
            onChange={event => updateItem(index, 'url', event.target.value)}
            placeholder={t('fields.example_conversation_placeholder')}
            aria-label={t('fields.example_conversation_url')}
            data-testid={`${testIdPrefix}-url-${index}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-text-muted hover:text-danger"
            onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            aria-label={t('fields.remove_example_conversation')}
            data-testid={`${testIdPrefix}-remove-${index}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={value.length >= MAX_EXAMPLE_CONVERSATIONS}
        onClick={() => onChange([...value, { title: '', url: '' }])}
        data-testid={`${testIdPrefix}-add`}
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t('fields.add_example_conversation')}
      </Button>
    </div>
  )
}
