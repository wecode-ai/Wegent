// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Send, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  FormSchema,
  FormContext,
  FormSubmissionResponse,
  FormFieldSchema,
} from '@/types/form'
import FormFieldRenderer from './FormFieldRenderer'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { formApis } from '@/apis/forms'

interface GenericFormProps {
  schema: FormSchema
  context: FormContext
  initialValues?: Record<string, unknown>
  onSubmitSuccess?: (result: FormSubmissionResponse) => void
  onSubmitError?: (error: Error) => void
  readonly?: boolean
}

/**
 * Generic form component that renders form fields based on a schema
 * and submits to the unified form submission endpoint.
 */
export default function GenericForm({
  schema,
  context,
  initialValues = {},
  onSubmitSuccess,
  onSubmitError,
  readonly = false,
}: GenericFormProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()

  // Form values state
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    // Initialize with default values from schema, then override with initialValues
    const defaults: Record<string, unknown> = {}
    schema.fields.forEach(field => {
      if (field.default_value !== undefined) {
        defaults[field.field_id] = field.default_value
      } else {
        // Set type-appropriate default empty values
        switch (field.field_type) {
          case 'multiple_choice':
            defaults[field.field_id] = []
            break
          case 'number_input':
            defaults[field.field_id] = 0
            break
          default:
            defaults[field.field_id] = ''
        }
      }
    })
    return { ...defaults, ...initialValues }
  })

  // Validation errors
  const [errors, setErrors] = useState<Set<string>>(new Set())

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Handle field value change
  const handleFieldChange = useCallback((fieldId: string, value: unknown) => {
    setValues(prev => ({ ...prev, [fieldId]: value }))
    // Clear error when user provides a value
    setErrors(prev => {
      const newErrors = new Set(prev)
      newErrors.delete(fieldId)
      return newErrors
    })
  }, [])

  // Validate form
  const validate = useCallback((): boolean => {
    const newErrors = new Set<string>()

    schema.fields.forEach((field: FormFieldSchema) => {
      if (!field.required) return

      const value = values[field.field_id]

      // Check if value is empty
      const isEmpty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)

      if (isEmpty) {
        newErrors.add(field.field_id)
      }

      // Validate against validation rules if provided
      if (field.validation && !isEmpty) {
        if (field.field_type === 'number_input') {
          const numValue = value as number
          if (field.validation.min !== undefined && numValue < field.validation.min) {
            newErrors.add(field.field_id)
          }
          if (field.validation.max !== undefined && numValue > field.validation.max) {
            newErrors.add(field.field_id)
          }
        }

        if (field.validation.pattern && typeof value === 'string') {
          const regex = new RegExp(field.validation.pattern)
          if (!regex.test(value)) {
            newErrors.add(field.field_id)
          }
        }
      }
    })

    setErrors(newErrors)
    return newErrors.size === 0
  }, [schema.fields, values])

  // Handle form submission
  const handleSubmit = useCallback(async () => {
    if (readonly || isSubmitting) return

    // Validate
    if (!validate()) {
      toast({
        title: t('form.validation_error') || 'Please fill in all required fields',
        variant: 'destructive',
      })
      return
    }

    setIsSubmitting(true)

    try {
      const response = await formApis.submit({
        action_type: schema.action_type,
        form_data: values,
        context,
      })

      if (response.status === 'completed' || response.status === 'processing') {
        toast({
          title: t('form.submit_success') || 'Form submitted successfully',
        })
        onSubmitSuccess?.(response)
      } else if (response.status === 'error') {
        throw new Error(response.message || 'Submission failed')
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error')
      toast({
        title: t('form.submit_failed') || 'Failed to submit form',
        description: err.message,
        variant: 'destructive',
      })
      onSubmitError?.(err)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    readonly,
    isSubmitting,
    validate,
    schema.action_type,
    values,
    context,
    toast,
    t,
    onSubmitSuccess,
    onSubmitError,
  ])

  // Render
  return (
    <div className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5">
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-base font-semibold text-primary">{schema.title}</h3>
        {schema.description && (
          <p className="text-sm text-text-secondary mt-1">{schema.description}</p>
        )}
      </div>

      {/* Fields */}
      <div className="space-y-4">
        {schema.fields.map(field => (
          <div
            key={field.field_id}
            className={`p-3 rounded bg-surface/50 border transition-colors ${
              errors.has(field.field_id)
                ? 'border-red-500 bg-red-500/5'
                : 'border-border'
            }`}
          >
            <FormFieldRenderer
              field={field}
              value={values[field.field_id]}
              onChange={value => handleFieldChange(field.field_id, value)}
              disabled={readonly || isSubmitting}
              error={errors.has(field.field_id)}
            />
          </div>
        ))}
      </div>

      {/* Submit button */}
      {!readonly && (
        <div className="flex justify-end pt-2">
          <Button
            variant="secondary"
            onClick={handleSubmit}
            disabled={isSubmitting}
            size="lg"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-2" />
            )}
            {schema.submit_label || t('form.submit') || 'Submit'}
          </Button>
        </div>
      )}
    </div>
  )
}
