// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FormFieldSchema } from '@/types/form'

interface DateTimePickerFieldProps {
  field: FormFieldSchema
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  error?: boolean
}

export default function DateTimePickerField({
  field,
  value,
  onChange,
  disabled = false,
  error = false,
}: DateTimePickerFieldProps) {
  return (
    <div className="space-y-2">
      <Label
        className={`text-sm font-medium ${error ? 'text-red-500' : 'text-text-primary'}`}
      >
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      <Input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full ${error ? 'border-red-500' : ''}`}
      />
    </div>
  )
}
