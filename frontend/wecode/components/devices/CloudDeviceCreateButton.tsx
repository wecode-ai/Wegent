// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device create button for header placement.
 *
 * This component is designed to be placed in the page header,
 * separate from the CloudDeviceSection.
 */

'use client'

import '@wecode/i18n'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
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
import { Cloud, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cloudDeviceApis, CloudDeviceConfig } from '@wecode/apis/cloud-devices'

interface CloudDeviceCreateButtonProps {
  onDeviceCreated: () => void
}

export function CloudDeviceCreateButton({ onDeviceCreated }: CloudDeviceCreateButtonProps) {
  const { t } = useTranslation('wecode')
  const [isCreating, setIsCreating] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [cloudConfig, setCloudConfig] = useState<CloudDeviceConfig | null>(null)

  // Fetch cloud device configuration
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await cloudDeviceApis.getCloudDeviceConfig()
        setCloudConfig(config)
      } catch (error) {
        console.error('Failed to fetch cloud device config:', error)
      }
    }
    fetchConfig()
  }, [])

  const handleCreate = useCallback(async () => {
    setShowConfirm(false)
    setIsCreating(true)
    try {
      await cloudDeviceApis.createCloudDevice()
      toast.success(t('cloud_device.create_success'))
      onDeviceCreated()
    } catch (error: unknown) {
      const apiError = error as { status?: number; message?: string }
      if (apiError?.status === 400) {
        toast.error(
          t('cloud_device.limit_reached', { max: cloudConfig?.max_devices_per_user || 1 })
        )
      } else if (apiError?.status === 503) {
        toast.error(t('cloud_device.not_configured'))
      } else {
        toast.error(t('cloud_device.create_error'))
      }
    } finally {
      setIsCreating(false)
    }
  }, [t, onDeviceCreated, cloudConfig])

  // Don't render if cloud devices are not enabled or user cannot create
  if (!cloudConfig?.enabled || !cloudConfig?.can_create) {
    return null
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowConfirm(true)}
        disabled={isCreating}
        className="flex items-center gap-2"
      >
        {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
        {t('cloud_device.create')}
      </Button>

      {/* Create confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cloud_device.create_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cloud_device.create_confirm_message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCreate}
              className="bg-primary text-white hover:bg-primary/90"
            >
              {t('cloud_device.create')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
