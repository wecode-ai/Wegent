// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import type {
  InteractiveFormField as FormFieldType,
  InteractiveFieldOption,
  InteractiveShowCondition,
} from './types'

interface InteractiveFormFieldProps {
  field: FormFieldType
  value: unknown
  onChange: (value: unknown) => void
  formValues: Record<string, unknown>
  disabled?: boolean
  error?: string
}

/**
 * Render a single form field based on its type.
 */
export function InteractiveFormField({
  field,
  value,
  onChange,
  formValues,
  disabled = false,
  error,
}: InteractiveFormFieldProps) {
  // Check if field should be shown based on show_when condition
  const isVisible = useMemo(() => {
    if (!field.show_when) return true

    const { field_id, operator, value: conditionValue } = field.show_when
    const dependentValue = formValues[field_id]

    switch (operator) {
      case 'equals':
        return dependentValue === conditionValue
      case 'not_equals':
        return dependentValue !== conditionValue
      case 'contains':
        if (typeof dependentValue === 'string') {
          return dependentValue.includes(String(conditionValue))
        }
        if (Array.isArray(dependentValue)) {
          return dependentValue.includes(conditionValue)
        }
        return false
      case 'in':
        if (Array.isArray(conditionValue)) {
          return conditionValue.includes(dependentValue)
        }
        return false
      default:
        return true
    }
  }, [field.show_when, formValues])

  if (!isVisible) {
    return null
  }

  const isRequired = field.validation?.required

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1">
        {field.label}
        {isRequired && <span className="text-red-500">*</span>}
      </Label>

      {renderFieldInput(field, value, onChange, disabled)}

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

function renderFieldInput(
  field: FormFieldType,
  value: unknown,
  onChange: (value: unknown) => void,
  disabled: boolean
) {
  switch (field.field_type) {
    case 'text':
      return (
        <Input
          type="text"
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          maxLength={field.validation?.max_length}
        />
      )

    case 'textarea':
      return (
        <Textarea
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          maxLength={field.validation?.max_length}
          rows={4}
        />
      )

    case 'number':
      return (
        <Input
          type="number"
          placeholder={field.placeholder}
          value={(value as number) ?? ''}
          onChange={e => onChange(e.target.value ? Number(e.target.value) : undefined)}
          disabled={disabled}
          min={field.validation?.min}
          max={field.validation?.max}
        />
      )

    case 'single_choice':
      return (
        <RadioGroup
          value={(value as string) ?? ''}
          onValueChange={onChange}
          disabled={disabled}
          className="space-y-2"
        >
          {field.options?.map(option => (
            <div key={option.value} className="flex items-center space-x-2">
              <RadioGroupItem value={option.value} id={`${field.field_id}-${option.value}`} />
              <Label
                htmlFor={`${field.field_id}-${option.value}`}
                className="flex items-center gap-2 cursor-pointer"
              >
                {option.label}
                {option.recommended && (
                  <Badge variant="secondary" className="text-xs">
                    Recommended
                  </Badge>
                )}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )

    case 'multiple_choice':
      const selectedValues = (value as string[]) ?? []
      return (
        <div className="space-y-2">
          {field.options?.map(option => (
            <div key={option.value} className="flex items-center space-x-2">
              <Checkbox
                id={`${field.field_id}-${option.value}`}
                checked={selectedValues.includes(option.value)}
                onCheckedChange={checked => {
                  if (checked) {
                    onChange([...selectedValues, option.value])
                  } else {
                    onChange(selectedValues.filter(v => v !== option.value))
                  }
                }}
                disabled={disabled}
              />
              <Label
                htmlFor={`${field.field_id}-${option.value}`}
                className="flex items-center gap-2 cursor-pointer"
              >
                {option.label}
                {option.recommended && (
                  <Badge variant="secondary" className="text-xs">
                    Recommended
                  </Badge>
                )}
              </Label>
            </div>
          ))}
        </div>
      )

    case 'datetime':
      return (
        <Input
          type="datetime-local"
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      )

    default:
      return (
        <Input
          type="text"
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      )
  }
}
