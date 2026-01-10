// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import type { FormFieldSchema, FormFieldOption } from '@/types/form'

interface MultipleChoiceFieldProps {
  field: FormFieldSchema
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
  error?: boolean
}

export default function MultipleChoiceField({
  field,
  value,
  onChange,
  disabled = false,
  error = false,
}: MultipleChoiceFieldProps) {
  const options = field.options || []

  const handleToggle = (optionValue: string) => {
    if (value.includes(optionValue)) {
      onChange(value.filter(v => v !== optionValue))
    } else {
      onChange([...value, optionValue])
    }
  }

  return (
    <div className="space-y-2">
      <Label
        className={`text-sm font-medium ${error ? 'text-red-500' : 'text-text-primary'}`}
      >
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      <div className="flex flex-col space-y-2">
        {options.map((option: FormFieldOption) => (
          <div key={option.value} className="flex items-center space-x-2">
            <Checkbox
              id={`${field.field_id}-${option.value}`}
              checked={value.includes(option.value)}
              onCheckedChange={() => handleToggle(option.value)}
              disabled={disabled}
              className={error ? 'border-red-500' : ''}
            />
            <Label
              htmlFor={`${field.field_id}-${option.value}`}
              className="text-sm text-text-secondary cursor-pointer flex items-center gap-2"
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
    </div>
  )
}
