// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
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
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { greyApis } from '@/apis/grey'
import { Loader2 } from 'lucide-react'

export default function GreyTestButton() {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [isGreyUser, setIsGreyUser] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  // Fetch grey status on mount
  const fetchGreyStatus = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await greyApis.getStatus()
      setIsGreyUser(response.is_grey_user)
    } catch (error) {
      console.error('Failed to fetch grey status:', error)
      // Set to false on error, allow user to try joining
      setIsGreyUser(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGreyStatus()
  }, [fetchGreyStatus])

  const handleConfirm = async () => {
    setIsProcessing(true)
    try {
      if (isGreyUser) {
        // Leave grey test
        const response = await greyApis.leave()
        if (response.success) {
          setIsGreyUser(response.is_grey_user)
          toast({
            title: t('grey.leaveSuccess'),
          })
        }
      } else {
        // Join grey test
        const response = await greyApis.join()
        if (response.success) {
          setIsGreyUser(response.is_grey_user)
          toast({
            title: t('grey.joinSuccess'),
          })
        }
      }
    } catch (error) {
      console.error('Grey action failed:', error)
      toast({
        variant: 'destructive',
        title: t('grey.error'),
      })
    } finally {
      setIsProcessing(false)
      setShowConfirmDialog(false)
    }
  }

  // Don't render while loading initial status
  if (isLoading || isGreyUser === null) {
    return null
  }

  const buttonText = isGreyUser ? t('grey.leaveButton') : t('grey.joinButton')
  const confirmTitle = isGreyUser ? t('grey.leaveConfirmTitle') : t('grey.joinConfirmTitle')
  const confirmMessage = isGreyUser ? t('grey.leaveConfirmMessage') : t('grey.joinConfirmMessage')

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowConfirmDialog(true)}
        className="text-text-secondary hover:text-text-primary"
      >
        {buttonText}
      </Button>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} disabled={isProcessing}>
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('actions.loading')}
                </>
              ) : (
                t('actions.confirm')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
