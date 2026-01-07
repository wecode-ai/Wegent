// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

interface WizardStepIndicatorProps {
  currentStep: number
  totalSteps: number
}

const stepKeys = [
  'wizard:step1_title',
  'wizard:step2_title',
  'wizard:step3_title',
  'wizard:step4_title',
]

export default function WizardStepIndicator({ currentStep, totalSteps }: WizardStepIndicatorProps) {
  const { t } = useTranslation()

  return (
    <div className="w-full mb-6">
      <div className="flex items-center justify-between">
        {Array.from({ length: totalSteps }, (_, i) => i + 1).map(step => {
          const isCompleted = step < currentStep
          const isCurrent = step === currentStep

          return (
            <div key={step} className="flex items-center flex-1 last:flex-none">
              {/* Step circle */}
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-colors',
                    isCompleted
                      ? 'bg-primary border-primary text-white'
                      : isCurrent
                        ? 'border-primary text-primary bg-surface'
                        : 'border-border text-text-muted bg-surface'
                  )}
                >
                  {isCompleted ? <Check className="w-4 h-4" /> : step}
                </div>
                <span
                  className={cn(
                    'mt-1.5 text-xs whitespace-nowrap',
                    isCurrent ? 'text-text-primary font-medium' : 'text-text-muted'
                  )}
                >
                  {t(stepKeys[step - 1])}
                </span>
              </div>

              {/* Connector line */}
              {step < totalSteps && (
                <div
                  className={cn(
                    'flex-1 h-0.5 mx-2',
                    step < currentStep ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
