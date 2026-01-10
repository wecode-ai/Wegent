// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FormFieldSchema } from '@/types/form'

interface NumberInputFieldProps {
  field: FormFieldSchema
  value: number | string
  onChange: (value: number) => void
  disabled?: boolean
  error?: boolean
}

export default function NumberInputField({
  field,
  value,
  onChange,
  disabled = false,
  error = false,
}: NumberInputFieldProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    if (val === '' || val === '-') {
      onChange(0)
    } else {
      const num = parseFloat(val)
      if (!isNaN(num)) {
        onChange(num)
      }
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
      <Input
        type="number"
        value={value}
        onChange={handleChange}
        placeholder={field.placeholder}
        disabled={disabled}
        min={field.validation?.min}
        max={field.validation?.max}
        className={`w-full ${error ? 'border-red-500' : ''}`}
      />
    </div>
  )
}
