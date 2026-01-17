// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Check, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import type { InteractiveSelectDefinition, InteractiveResponsePayload } from './types'

interface InteractiveSelectProps {
  requestId: string
  select: InteractiveSelectDefinition
  taskId: number
  onSubmit: (response: InteractiveResponsePayload) => void
  disabled?: boolean
}

/**
 * Interactive selection dialog component.
 */
export function InteractiveSelect({
  requestId,
  select,
  taskId,
  onSubmit,
  disabled = false,
}: InteractiveSelectProps) {
  const { t } = useTranslation('chat')
  const [selected, setSelected] = useState<string[]>(() => {
    // Initialize with recommended options
    return select.options.filter(o => o.recommended).map(o => o.value)
  })
  const [isSubmitted, setIsSubmitted] = useState(false)

  const handleSingleSelect = useCallback((value: string) => {
    setSelected([value])
  }, [])

  const handleMultiSelect = useCallback((value: string, checked: boolean) => {
    if (checked) {
      setSelected(prev => [...prev, value])
    } else {
      setSelected(prev => prev.filter(v => v !== value))
    }
  }, [])

  const handleSubmit = useCallback(() => {
    setIsSubmitted(true)

    const response: InteractiveResponsePayload = {
      request_id: requestId,
      response_type: 'select',
      data: { selected: select.multiple ? selected : selected[0] },
      task_id: taskId,
    }

    onSubmit(response)
  }, [requestId, selected, select.multiple, taskId, onSubmit])

  const isDisabled = disabled || isSubmitted

  return (
    <div className="space-y-4 p-4 rounded-lg border border-blue-500/30 bg-blue-500/5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">📋</span>
        <h3 className="text-base font-semibold text-blue-600">{select.title}</h3>
      </div>

      {select.description && (
        <p className="text-sm text-text-secondary mb-4">{select.description}</p>
      )}

      <div className="space-y-2">
        {select.multiple ? (
          // Multiple selection with checkboxes
          select.options.map(option => (
            <div
              key={option.value}
              className={`flex items-start space-x-3 p-3 rounded-lg border transition-colors ${
                selected.includes(option.value)
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-border bg-surface/50'
              }`}
            >
              <Checkbox
                id={`select-${option.value}`}
                checked={selected.includes(option.value)}
                onCheckedChange={checked => handleMultiSelect(option.value, !!checked)}
                disabled={isDisabled}
              />
              <div className="flex-1">
                <Label
                  htmlFor={`select-${option.value}`}
                  className="flex items-center gap-2 cursor-pointer font-medium"
                >
                  {option.label}
                  {option.recommended && (
                    <Badge variant="secondary" className="text-xs">
                      Recommended
                    </Badge>
                  )}
                </Label>
                {option.description && (
                  <p className="text-sm text-text-muted mt-1">{option.description}</p>
                )}
              </div>
            </div>
          ))
        ) : (
          // Single selection with radio buttons
          <RadioGroup
            value={selected[0] ?? ''}
            onValueChange={handleSingleSelect}
            disabled={isDisabled}
            className="space-y-2"
          >
            {select.options.map(option => (
              <div
                key={option.value}
                className={`flex items-start space-x-3 p-3 rounded-lg border transition-colors ${
                  selected.includes(option.value)
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-border bg-surface/50'
                }`}
              >
                <RadioGroupItem value={option.value} id={`select-${option.value}`} />
                <div className="flex-1">
                  <Label
                    htmlFor={`select-${option.value}`}
                    className="flex items-center gap-2 cursor-pointer font-medium"
                  >
                    {option.label}
                    {option.recommended && (
                      <Badge variant="secondary" className="text-xs">
                        Recommended
                      </Badge>
                    )}
                  </Label>
                  {option.description && (
                    <p className="text-sm text-text-muted mt-1">{option.description}</p>
                  )}
                </div>
              </div>
            ))}
          </RadioGroup>
        )}
      </div>

      {!isSubmitted ? (
        <div className="flex justify-end pt-2">
          <Button
            variant="secondary"
            onClick={handleSubmit}
            disabled={isDisabled || selected.length === 0}
          >
            <Send className="w-4 h-4 mr-2" />
            {t('interactive.submit_selection') || 'Submit Selection'}
          </Button>
        </div>
      ) : (
        <div className="text-center text-sm text-text-muted pt-2 flex items-center justify-center gap-1">
          <Check className="w-4 h-4 text-green-600" />
          {t('interactive.selection_submitted') || 'Selection submitted'}
        </div>
      )}
    </div>
  )
}
