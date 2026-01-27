'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * InputParameterForm component for rendering dynamic input forms
 * based on input parameter definitions.
 *
 * Supports three parameter types:
 * - text: Single-line text input
 * - textarea: Multi-line text input
 * - select: Dropdown select with predefined options
 */
import { useTranslation } from '@/hooks/useTranslation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { InputParameter } from '@/types/input-parameter'

interface InputParameterFormProps {
  /** List of input parameter definitions */
  parameters: InputParameter[]
  /** Current values for each parameter (keyed by parameter name) */
  values: Record<string, string>
  /** Callback when any parameter value changes */
  onChange: (values: Record<string, string>) => void
  /** Whether the form is disabled */
  disabled?: boolean
}

/**
 * Renders a dynamic form based on input parameter definitions.
 * Each parameter is rendered as an appropriate input control based on its type.
 */
export function InputParameterForm({
  parameters,
  values,
  onChange,
  disabled = false,
}: InputParameterFormProps) {
  const { t } = useTranslation('common')

  if (!parameters || parameters.length === 0) {
    return null
  }

  const handleChange = (name: string, value: string) => {
    onChange({
      ...values,
      [name]: value,
    })
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary mb-2">{t('input_parameters.description')}</div>
      {parameters.map(param => (
        <div key={param.name} className="space-y-2">
          <Label htmlFor={`param-${param.name}`} className="text-sm font-medium">
            {param.label}
          </Label>
          {param.type === 'text' && (
            <Input
              id={`param-${param.name}`}
              value={values[param.name] || ''}
              onChange={e => handleChange(param.name, e.target.value)}
              placeholder={param.label}
              disabled={disabled}
            />
          )}
          {param.type === 'textarea' && (
            <Textarea
              id={`param-${param.name}`}
              value={values[param.name] || ''}
              onChange={e => handleChange(param.name, e.target.value)}
              placeholder={param.label}
              disabled={disabled}
              className="min-h-[100px]"
            />
          )}
          {param.type === 'select' && param.options && (
            <Select
              value={values[param.name] || ''}
              onValueChange={value => handleChange(param.name, value)}
              disabled={disabled}
            >
              <SelectTrigger id={`param-${param.name}`}>
                <SelectValue placeholder={param.label} />
              </SelectTrigger>
              <SelectContent>
                {param.options.map(option => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ))}
    </div>
  )
}
