// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { FormFieldSchema, FormFieldType } from '@/types/form'
import {
  SingleChoiceField,
  MultipleChoiceField,
  TextInputField,
  DateTimePickerField,
  NumberInputField,
} from './fields'

interface FormFieldRendererProps {
  field: FormFieldSchema
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  error?: boolean
}

/**
 * Renders the appropriate form field component based on field type.
 */
export default function FormFieldRenderer({
  field,
  value,
  onChange,
  disabled = false,
  error = false,
}: FormFieldRendererProps) {
  const fieldType: FormFieldType = field.field_type

  switch (fieldType) {
    case 'single_choice':
      return (
        <SingleChoiceField
          field={field}
          value={(value as string) || ''}
          onChange={onChange as (value: string) => void}
          disabled={disabled}
          error={error}
        />
      )

    case 'multiple_choice':
      return (
        <MultipleChoiceField
          field={field}
          value={(value as string[]) || []}
          onChange={onChange as (value: string[]) => void}
          disabled={disabled}
          error={error}
        />
      )

    case 'text_input':
      return (
        <TextInputField
          field={field}
          value={(value as string) || ''}
          onChange={onChange as (value: string) => void}
          disabled={disabled}
          error={error}
        />
      )

    case 'datetime_picker':
      return (
        <DateTimePickerField
          field={field}
          value={(value as string) || ''}
          onChange={onChange as (value: string) => void}
          disabled={disabled}
          error={error}
        />
      )

    case 'number_input':
      return (
        <NumberInputField
          field={field}
          value={(value as number) || 0}
          onChange={onChange as (value: number) => void}
          disabled={disabled}
          error={error}
        />
      )

    default:
      // Unknown field type - render as text input
      console.warn(`Unknown field type: ${fieldType}, falling back to text input`)
      return (
        <TextInputField
          field={field}
          value={(value as string) || ''}
          onChange={onChange as (value: string) => void}
          disabled={disabled}
          error={error}
        />
      )
  }
}
