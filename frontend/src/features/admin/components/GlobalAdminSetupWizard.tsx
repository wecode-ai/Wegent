// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { CheckCircleIcon } from '@heroicons/react/24/outline'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { adminApis } from '@/apis/admin'
import { userApis } from '@/apis/user'
import { useUser } from '@/features/common/UserContext'
import SetupModelStep from './SetupModelStep'
import SetupSkillStep from './SetupSkillStep'

const TOTAL_STEPS = 2

/**
 * Global Admin Setup Wizard component that shows on any page when:
 * 1. Current user is an admin
 * 2. Admin setup has not been completed yet
 *
 * This component should be placed in the root layout to ensure it shows
 * regardless of which page the admin first lands on.
 *
 * Setup status is fetched from the welcome-config API to avoid extra API calls.
 */
const GlobalAdminSetupWizard: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const { user, isLoading: userLoading } = useUser()

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(1)
  const [isSkipDialogOpen, setIsSkipDialogOpen] = useState(false)
  const [completing, setCompleting] = useState(false)

  // Check setup status when user is loaded and is admin
  useEffect(() => {
    const checkSetupStatus = async () => {
      // Wait for user to be loaded
      if (userLoading) {
        return
      }

      // Only check for admin users
      if (!user || user.role !== 'admin') {
        setLoading(false)
        return
      }

      try {
        // Get setup status from welcome-config API
        const response = await userApis.getWelcomeConfig()
        // admin_setup_completed is only returned for admin users
        if (response.admin_setup_completed === false) {
          setOpen(true)
        }
      } catch (error) {
        console.error('Failed to check setup status:', error)
        // Don't show error toast for network errors
        // The wizard simply won't show
      } finally {
        setLoading(false)
      }
    }

    checkSetupStatus()
  }, [user, userLoading])

  const handleNext = useCallback(() => {
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep(prev => prev + 1)
    }
  }, [currentStep])

  const handlePrevious = useCallback(() => {
    if (currentStep > 1) {
      setCurrentStep(prev => prev - 1)
    }
  }, [currentStep])

  const handleComplete = useCallback(async () => {
    setCompleting(true)
    try {
      await adminApis.markSetupComplete()
      toast({
        title: t('setup_wizard.success.completed'),
      })
      setOpen(false)
      // Reload the page to refresh model list and other data
      window.location.reload()
    } catch (error) {
      console.error('Failed to complete setup:', error)
      toast({
        variant: 'destructive',
        title: t('setup_wizard.errors.complete_failed'),
      })
      setCompleting(false)
    }
  }, [toast, t])

  const handleSkip = useCallback(async () => {
    setCompleting(true)
    try {
      await adminApis.markSetupComplete()
      toast({
        title: t('setup_wizard.success.skipped'),
      })
      setOpen(false)
      // Reload the page to refresh model list and other data
      window.location.reload()
    } catch (error) {
      console.error('Failed to skip setup:', error)
      toast({
        variant: 'destructive',
        title: t('setup_wizard.errors.complete_failed'),
      })
      setCompleting(false)
      setIsSkipDialogOpen(false)
    }
  }, [toast, t])

  // Don't render anything while checking status or if not admin
  if (loading || userLoading || !user || user.role !== 'admin') {
    return null
  }

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
        <div
          key={index}
          className={`w-3 h-3 rounded-full transition-colors ${
            index + 1 === currentStep
              ? 'bg-primary'
              : index + 1 < currentStep
                ? 'bg-primary/60'
                : 'bg-border'
          }`}
        />
      ))}
    </div>
  )

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return <SetupModelStep />
      case 2:
        return <SetupSkillStep />
      default:
        return null
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={nextOpen => {
          if (!nextOpen && !completing) {
            setIsSkipDialogOpen(true)
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col bg-surface">
          <DialogHeader className="text-center pb-2">
            <div className="flex justify-center mb-4">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <CheckCircleIcon className="w-8 h-8 text-primary" />
              </div>
            </div>
            <DialogTitle className="text-xl">{t('setup_wizard.title')}</DialogTitle>
            <DialogDescription className="text-text-muted">
              {t('setup_wizard.subtitle')}
            </DialogDescription>
          </DialogHeader>

          {/* Step Indicator */}
          <div className="flex-shrink-0">
            {renderStepIndicator()}
            <div className="text-center text-sm text-text-muted mb-4">
              {t('setup_wizard.step_indicator', { current: currentStep, total: TOTAL_STEPS })}
            </div>
          </div>

          {/* Step Content */}
          <div className="flex-1 overflow-y-auto px-1">{renderStepContent()}</div>

          <DialogFooter className="flex-shrink-0 pt-4 border-t border-border mt-4">
            <div className="flex w-full justify-between">
              <Button
                variant="ghost"
                onClick={() => setIsSkipDialogOpen(true)}
                disabled={completing}
              >
                {t('setup_wizard.skip')}
              </Button>
              <div className="flex gap-2">
                {currentStep > 1 && (
                  <Button variant="outline" onClick={handlePrevious} disabled={completing}>
                    {t('setup_wizard.previous')}
                  </Button>
                )}
                {currentStep < TOTAL_STEPS ? (
                  <Button variant="primary" onClick={handleNext} disabled={completing}>
                    {t('setup_wizard.next')}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={handleComplete} disabled={completing}>
                    {completing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('common.loading')}
                      </>
                    ) : (
                      t('setup_wizard.finish')
                    )}
                  </Button>
                )}
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skip Confirmation Dialog */}
      <AlertDialog open={isSkipDialogOpen} onOpenChange={setIsSkipDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('setup_wizard.skip_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('setup_wizard.skip_confirm_message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={handleSkip} disabled={completing}>
              {completing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('setup_wizard.skip_confirm_yes')
              )}
            </AlertDialogAction>
            <AlertDialogCancel
              disabled={completing}
              className="bg-primary text-white hover:bg-primary/90"
            >
              {t('setup_wizard.skip_confirm_no')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default GlobalAdminSetupWizard
