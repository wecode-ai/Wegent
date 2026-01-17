// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { InteractiveFormField } from './InteractiveFormField'
import type {
  InteractiveFormDefinition,
  InteractiveFormField as FormFieldType,
  InteractiveResponsePayload,
} from './types'

interface InteractiveFormProps {
  requestId: string
  form: InteractiveFormDefinition
  taskId: number
  onSubmit: (response: InteractiveResponsePayload) => void
  disabled?: boolean
}

/**
 * Interactive form component for collecting structured user input.
 */
export function InteractiveForm({
  requestId,
  form,
  taskId,
  onSubmit,
  disabled = false,
}: InteractiveFormProps) {
  const { t } = useTranslation('chat')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitted, setIsSubmitted] = useState(false)

  // Initialize default values
  useEffect(() => {
    const initialValues: Record<string, unknown> = {}
    form.fields.forEach(field => {
      if (field.default_value !== undefined) {
        initialValues[field.field_id] = field.default_value
      } else if (field.field_type === 'multiple_choice') {
        // Initialize with recommended options for multiple choice
        const recommended = field.options?.filter(o => o.recommended).map(o => o.value) ?? []
        initialValues[field.field_id] = recommended
      } else if (field.field_type === 'single_choice') {
        // Initialize with recommended option for single choice
        const recommended = field.options?.find(o => o.recommended)
        if (recommended) {
          initialValues[field.field_id] = recommended.value
        }
      }
    })
    setValues(initialValues)
  }, [form.fields])

  // Helper function to check if a field is visible based on show_when condition
  const isFieldVisible = useCallback(
    (field: FormFieldType): boolean => {
      if (!field.show_when) return true

      const { field_id, operator, value: conditionValue } = field.show_when
      const dependentValue = values[field_id]

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
    },
    [values]
  )

  const handleFieldChange = useCallback((fieldId: string, value: unknown) => {
    setValues(prev => ({
      ...prev,
      [fieldId]: value,
    }))
    // Clear error when field is modified
    setErrors(prev => {
      const newErrors = { ...prev }
      delete newErrors[fieldId]
      return newErrors
    })
  }, [])

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {}

    form.fields.forEach(field => {
      // Skip validation for hidden fields
      if (!isFieldVisible(field)) return

      const value = values[field.field_id]
      const validation = field.validation

      if (!validation) return

      // Check required
      if (validation.required) {
        if (value === undefined || value === null || value === '') {
          newErrors[field.field_id] = t('interactive.field_required') || 'This field is required'
          return
        }
        if (Array.isArray(value) && value.length === 0) {
          newErrors[field.field_id] =
            t('interactive.select_at_least_one') || 'Please select at least one option'
          return
        }
      }

      // Check string validations
      if (typeof value === 'string') {
        if (validation.min_length && value.length < validation.min_length) {
          newErrors[field.field_id] =
            t('interactive.min_length', { min: validation.min_length }) ||
            `Minimum ${validation.min_length} characters required`
        }
        if (validation.max_length && value.length > validation.max_length) {
          newErrors[field.field_id] =
            t('interactive.max_length', { max: validation.max_length }) ||
            `Maximum ${validation.max_length} characters allowed`
        }
        if (validation.pattern) {
          const regex = new RegExp(validation.pattern)
          if (!regex.test(value)) {
            newErrors[field.field_id] =
              validation.pattern_message || t('interactive.invalid_format') || 'Invalid format'
          }
        }
      }

      // Check number validations
      if (typeof value === 'number') {
        if (validation.min !== undefined && value < validation.min) {
          newErrors[field.field_id] =
            t('interactive.min_value', { min: validation.min }) || `Minimum value is ${validation.min}`
        }
        if (validation.max !== undefined && value > validation.max) {
          newErrors[field.field_id] =
            t('interactive.max_value', { max: validation.max }) || `Maximum value is ${validation.max}`
        }
      }
    })

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [form.fields, values, t, isFieldVisible])

  const handleSubmit = useCallback(() => {
    if (!validateForm()) return

    setIsSubmitted(true)

    const response: InteractiveResponsePayload = {
      request_id: requestId,
      response_type: 'form_submit',
      data: values,
      task_id: taskId,
    }

    onSubmit(response)
  }, [validateForm, requestId, values, taskId, onSubmit])

  const isDisabled = disabled || isSubmitted

  return (
    <div className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">📝</span>
        <h3 className="text-base font-semibold text-primary">{form.title}</h3>
      </div>

      {form.description && (
        <p className="text-sm text-text-secondary mb-4">{form.description}</p>
      )}

      <div className="space-y-4">
        {form.fields.map(field => (
          <div
            key={field.field_id}
            className={`p-3 rounded bg-surface/50 border ${
              errors[field.field_id] ? 'border-red-500 bg-red-500/5' : 'border-border'
            }`}
          >
            <InteractiveFormField
              field={field}
              value={values[field.field_id]}
              onChange={value => handleFieldChange(field.field_id, value)}
              formValues={values}
              disabled={isDisabled}
              error={errors[field.field_id]}
            />
          </div>
        ))}
      </div>

      {!isSubmitted && (
        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={handleSubmit} size="lg" disabled={isDisabled}>
            <Send className="w-4 h-4 mr-2" />
            {form.submit_button_text || t('interactive.submit') || 'Submit'}
          </Button>
        </div>
      )}

      {isSubmitted && (
        <div className="text-center text-sm text-text-muted pt-2">
          {t('interactive.form_submitted') || 'Form submitted'}
        </div>
      )}
    </div>
  )
}
