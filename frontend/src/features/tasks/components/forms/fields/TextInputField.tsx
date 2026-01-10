// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FormFieldSchema } from '@/types/form'

interface TextInputFieldProps {
  field: FormFieldSchema
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  error?: boolean
  multiline?: boolean
}

export default function TextInputField({
  field,
  value,
  onChange,
  disabled = false,
  error = false,
  multiline = true,
}: TextInputFieldProps) {
  return (
    <div className="space-y-2">
      <Label
        className={`text-sm font-medium ${error ? 'text-red-500' : 'text-text-primary'}`}
      >
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      {multiline ? (
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          rows={3}
          className={`w-full ${error ? 'border-red-500' : ''}`}
        />
      ) : (
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          className={`w-full ${error ? 'border-red-500' : ''}`}
        />
      )}
    </div>
  )
}
