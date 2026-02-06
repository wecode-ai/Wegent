// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { KeyIcon, CommandLineIcon, CheckIcon } from '@heroicons/react/24/outline'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { apiKeyApis, ApiKey, ApiKeyCreated } from '@/apis/api-keys'
import { cn } from '@/lib/utils'
import { ApiKeySelectionStep } from './device-setup/ApiKeySelectionStep'
import { CommandCopyStep } from './device-setup/CommandCopyStep'
import '@/features/common/scrollbar.css'

const STEPS = [
  { id: 1, icon: KeyIcon },
  { id: 2, icon: CommandLineIcon },
]

export function DeviceSetupGuide() {
  const { t } = useTranslation()
  const { toast } = useToast()

  // Current step
  const [currentStep, setCurrentStep] = useState(1)

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  // Selected key state
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null)
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<ApiKeyCreated | null>(null)

  // Fetch API keys
  const fetchApiKeys = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiKeyApis.getApiKeys()
      setApiKeys(response.items || [])
    } catch (error) {
      console.error('Failed to fetch API keys:', error)
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchApiKeys()
  }, [fetchApiKeys])

  // Handle key selection
  const handleSelectKey = (keyId: number | null, newKey?: ApiKeyCreated) => {
    setSelectedKeyId(keyId)
    if (newKey) {
      setNewlyCreatedKey(newKey)
    } else if (keyId !== newlyCreatedKey?.id) {
      // Clear newly created key when selecting a different existing key
      setNewlyCreatedKey(null)
    }
  }

  // Navigate to next step
  const handleNext = () => {
    if (currentStep < STEPS.length) {
      setCurrentStep(currentStep + 1)
    }
  }

  // Navigate to previous step
  const handlePrevious = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  // Check if can proceed to next step
  const canProceed = currentStep === 1 ? selectedKeyId !== null : true

  // Get step title based on step number
  const getStepTitle = (stepId: number) => {
    switch (stepId) {
      case 1:
        return t('common:device_setup.step1.title')
      case 2:
        return t('common:device_setup.step2.title')
      default:
        return ''
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('common:device_setup.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('common:device_setup.description')}</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-center gap-4 py-4">
        {STEPS.map((step, index) => {
          const StepIcon = step.icon
          const isActive = currentStep === step.id
          const isCompleted = currentStep > step.id

          return (
            <React.Fragment key={step.id}>
              {/* Step indicator */}
              <div className="flex flex-col items-center gap-2">
                <div
                  className={cn(
                    'w-10 h-10 rounded-full flex items-center justify-center transition-all',
                    isActive
                      ? 'bg-primary text-white'
                      : isCompleted
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted text-text-muted'
                  )}
                >
                  {isCompleted ? (
                    <CheckIcon className="w-5 h-5" />
                  ) : (
                    <StepIcon className="w-5 h-5" />
                  )}
                </div>
                <span
                  className={cn(
                    'text-xs font-medium',
                    isActive
                      ? 'text-primary'
                      : isCompleted
                        ? 'text-text-secondary'
                        : 'text-text-muted'
                  )}
                >
                  {getStepTitle(step.id)}
                </span>
              </div>

              {/* Connector line */}
              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    'w-16 h-0.5 mt-[-24px]',
                    currentStep > step.id ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </React.Fragment>
          )
        })}
      </div>

      {/* Step Content */}
      <Card className="p-6">
        {currentStep === 1 && (
          <ApiKeySelectionStep
            apiKeys={apiKeys}
            loading={loading}
            selectedKeyId={selectedKeyId}
            newlyCreatedKey={newlyCreatedKey}
            onSelectKey={handleSelectKey}
            onRefreshKeys={fetchApiKeys}
          />
        )}

        {currentStep === 2 && (
          <CommandCopyStep selectedKeyId={selectedKeyId} newlyCreatedKey={newlyCreatedKey} />
        )}
      </Card>

      {/* Navigation Buttons */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={handlePrevious} disabled={currentStep === 1}>
          {t('common:device_setup.actions.previous')}
        </Button>

        {currentStep < STEPS.length ? (
          <Button variant="primary" onClick={handleNext} disabled={!canProceed}>
            {t('common:device_setup.actions.next')}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setCurrentStep(1)}>
            {t('common:device_setup.actions.done')}
          </Button>
        )}
      </div>
    </div>
  )
}

export default DeviceSetupGuide
