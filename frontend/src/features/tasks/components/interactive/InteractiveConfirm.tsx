// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { InteractiveConfirmDefinition, InteractiveResponsePayload } from './types'

interface InteractiveConfirmProps {
  requestId: string
  confirm: InteractiveConfirmDefinition
  taskId: number
  onSubmit: (response: InteractiveResponsePayload) => void
  disabled?: boolean
}

/**
 * Interactive confirmation dialog component.
 */
export function InteractiveConfirm({
  requestId,
  confirm,
  taskId,
  onSubmit,
  disabled = false,
}: InteractiveConfirmProps) {
  const { t } = useTranslation('chat')
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [choice, setChoice] = useState<boolean | null>(null)

  const handleConfirm = useCallback(() => {
    setIsSubmitted(true)
    setChoice(true)

    const response: InteractiveResponsePayload = {
      request_id: requestId,
      response_type: 'confirm',
      data: { confirmed: true },
      task_id: taskId,
    }

    onSubmit(response)
  }, [requestId, taskId, onSubmit])

  const handleCancel = useCallback(() => {
    setIsSubmitted(true)
    setChoice(false)

    const response: InteractiveResponsePayload = {
      request_id: requestId,
      response_type: 'confirm',
      data: { confirmed: false },
      task_id: taskId,
    }

    onSubmit(response)
  }, [requestId, taskId, onSubmit])

  const isDisabled = disabled || isSubmitted

  return (
    <div className="space-y-4 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">❓</span>
        <h3 className="text-base font-semibold text-amber-600">{confirm.title}</h3>
      </div>

      <div className="prose prose-sm dark:prose-invert max-w-none">
        <MarkdownRenderer content={confirm.message} />
      </div>

      {!isSubmitted ? (
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={handleCancel} disabled={isDisabled}>
            <X className="w-4 h-4 mr-2" />
            {confirm.cancel_text || t('interactive.cancel') || 'Cancel'}
          </Button>
          <Button variant="default" onClick={handleConfirm} disabled={isDisabled}>
            <Check className="w-4 h-4 mr-2" />
            {confirm.confirm_text || t('interactive.confirm') || 'Confirm'}
          </Button>
        </div>
      ) : (
        <div className="text-center text-sm pt-2">
          {choice ? (
            <span className="text-green-600 flex items-center justify-center gap-1">
              <Check className="w-4 h-4" />
              {t('interactive.confirmed') || 'Confirmed'}
            </span>
          ) : (
            <span className="text-text-muted flex items-center justify-center gap-1">
              <X className="w-4 h-4" />
              {t('interactive.cancelled') || 'Cancelled'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
