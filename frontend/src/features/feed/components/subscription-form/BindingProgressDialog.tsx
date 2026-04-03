'use client'

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CheckCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type BindingProgressState = 'idle' | 'waiting' | 'success'

export interface BindingProgressStep {
  title: string
  hint?: string
}

interface BindingProgressDialogProps {
  open: boolean
  title: string
  description?: string
  state: BindingProgressState
  steps: BindingProgressStep[]
  startLabel: string
  waitingTitle: string
  waitingHint: string
  successTitle: string
  successHint?: string
  cancelLabel: string
  startTestId?: string
  onStart: () => void
  onCancel: () => void
  onOpenChange: (open: boolean) => void
  contentClassName?: string
}

function getStepClasses(index: number, state: BindingProgressState) {
  if (state === 'success') {
    return {
      circle: 'bg-success/10 text-success',
      label: 'text-text-muted',
      symbol: '✓',
    }
  }

  if (state === 'waiting') {
    if (index < 2) {
      return {
        circle: 'bg-success/10 text-success',
        label: 'text-text-muted',
        symbol: '✓',
      }
    }

    return {
      circle: 'bg-primary text-white',
      label: 'text-text-primary font-medium',
      symbol: String(index + 1),
    }
  }

  if (index === 0) {
    return {
      circle: 'bg-primary text-white',
      label: 'text-text-primary font-medium',
      symbol: '1',
    }
  }

  return {
    circle: 'bg-primary/10 text-primary',
    label: 'text-text-muted',
    symbol: String(index + 1),
  }
}

export function BindingProgressDialog({
  open,
  title,
  description,
  state,
  steps,
  startLabel,
  waitingTitle,
  waitingHint,
  successTitle,
  successHint,
  cancelLabel,
  startTestId,
  onStart,
  onCancel,
  onOpenChange,
  contentClassName,
}: BindingProgressDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex flex-col items-center py-6">
          <div className="w-full px-4 mb-6">
            <div className="space-y-3">
              {steps.map((step, index) => {
                const classes = getStepClasses(index, state)

                return (
                  <div key={`${step.title}-${index}`} className="flex items-start gap-3">
                    <div
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium shrink-0 transition-colors ${classes.circle}`}
                    >
                      {classes.symbol}
                    </div>
                    <div className="flex-1">
                      <p className={`text-sm transition-colors ${classes.label}`}>{step.title}</p>
                      {step.hint && <p className="text-xs text-text-muted mt-0.5">{step.hint}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {state === 'idle' && (
            <>
              <button
                type="button"
                data-testid={startTestId}
                onClick={onStart}
                className="relative w-36 h-36 rounded-full border-3 border-primary bg-surface flex flex-col items-center justify-center cursor-pointer transition-all duration-300 hover:scale-105 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                style={{ borderWidth: '3px' }}
              >
                <span className="text-lg font-semibold text-primary">{startLabel}</span>
              </button>
              <Button variant="outline" className="mt-6" onClick={onCancel}>
                {cancelLabel}
              </Button>
            </>
          )}

          {state === 'waiting' && (
            <>
              <div className="relative w-36 h-36">
                <div
                  className="absolute inset-0 rounded-full border-3 border-primary/20"
                  style={{ borderWidth: '3px' }}
                />
                <div
                  className="absolute inset-0 rounded-full border-3 border-transparent border-t-primary animate-spin"
                  style={{ borderWidth: '3px' }}
                />
                <div className="absolute inset-2 rounded-full bg-surface flex flex-col items-center justify-center">
                  <span className="text-sm font-medium text-text-primary mb-1">{waitingTitle}</span>
                  <span className="text-xs text-text-muted text-center px-3 leading-relaxed">
                    {waitingHint}
                  </span>
                </div>
              </div>
              <Button variant="outline" className="mt-6" onClick={onCancel}>
                {cancelLabel}
              </Button>
            </>
          )}

          {state === 'success' && (
            <div
              className="relative w-36 h-36 rounded-full border-3 border-success bg-surface flex flex-col items-center justify-center"
              style={{ borderWidth: '3px' }}
            >
              <CheckCircle className="h-10 w-10 text-success mb-1" />
              <span className="text-lg font-semibold text-success">{successTitle}</span>
              {successHint && (
                <span className="text-xs text-text-muted text-center px-3 truncate max-w-[120px] mt-1">
                  {successHint}
                </span>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
