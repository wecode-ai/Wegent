// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device creation section component.
 *
 * Provides a button and dialog for creating new cloud devices with optional Mail Skill configuration.
 * This component is extracted for reuse in the DeviceSetupGuide and CloudDeviceSection.
 */

'use client'

import '@wecode/i18n' // side-effect import to load wecode translations
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Cloud, Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cloudDeviceApis, CloudDeviceConfig } from '@wecode/apis/cloud-devices'

interface CloudDeviceCreateSectionProps {
  onDeviceCreated: () => void
  currentDeviceCount?: number
}

/**
 * Cloud device creation section component.
 *
 * Features:
 * - Fetches cloud device configuration on mount
 * - Shows create button (disabled if user reached limit)
 * - Create dialog with Mail Skill configuration (optional email + password fields)
 * - Error handling (limit reached, service not configured, generic errors)
 * - Loading states (button disabled during creation)
 */
export function CloudDeviceCreateSection({ onDeviceCreated, currentDeviceCount = 0 }: CloudDeviceCreateSectionProps) {
  const { t } = useTranslation('wecode')
  const [cloudConfig, setCloudConfig] = useState<CloudDeviceConfig | null>(null)
  const [showCreateConfirm, setShowCreateConfirm] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [mailEnabled, setMailEnabled] = useState(false)
  const [mailEmail, setMailEmail] = useState('')
  const [mailpassword, setMailpassword] = useState('')

  // Fetch cloud device configuration on mount
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

  // Create cloud device handler
  const handleCreateCloudDevice = useCallback(async () => {
    setShowCreateConfirm(false)
    setIsCreating(true)
    try {
      const body =
        mailEnabled && mailEmail && mailpassword
          ? { mail_email: mailEmail, mail_password: mailpassword }
          : undefined
      await cloudDeviceApis.createCloudDevice(body)
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
      setMailEnabled(false)
      setMailEmail('')
      setMailpassword('')
    }
  }, [t, onDeviceCreated, cloudConfig, mailEnabled, mailEmail, mailpassword])

  // Permission checks - compare current device count with max allowed
  const canCreateMore =
    cloudConfig?.can_create !== false &&
    (!cloudConfig || currentDeviceCount < cloudConfig.max_devices_per_user)

  // Hide if not enabled
  if (cloudConfig && !cloudConfig.enabled) {
    return null
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Cloud className="w-12 h-12 text-primary mb-4" />
      <h3 className="text-lg font-semibold mb-2">{t('cloud_device.create_confirm_title')}</h3>
      <p className="text-sm text-text-muted max-w-md mb-6">{t('cloud_device.description')}</p>
      <Button
        variant="primary"
        onClick={() => setShowCreateConfirm(true)}
        disabled={isCreating || !canCreateMore}
        className="flex items-center gap-2"
      >
        {isCreating ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Plus className="w-4 h-4" />
        )}
        {t('cloud_device.create')}
      </Button>

      {/* Create confirmation dialog */}
      <Dialog
        open={showCreateConfirm}
        onOpenChange={open => {
          setShowCreateConfirm(open)
          if (!open) {
            setMailEnabled(false)
            setMailEmail('')
            setMailpassword('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cloud_device.create_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('cloud_device.create_confirm_message')}
              <br />
              <span className="text-yellow-600 dark:text-yellow-500">
                {t('cloud_device.create_confirm_note')}
              </span>
            </DialogDescription>
          </DialogHeader>

          {/* Mail skill section */}
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="mail-enable"
                checked={mailEnabled}
                onCheckedChange={checked => setMailEnabled(checked === true)}
              />
              <Label htmlFor="mail-enable" className="text-sm font-medium cursor-pointer">
                {t('cloud_device.mail_enable')}
              </Label>
            </div>
            {mailEnabled && (
              <div className="space-y-3 pl-6">
                <div className="space-y-1">
                  <Label htmlFor="mail-email" className="text-sm">
                    {t('cloud_device.mail_email')}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="mail-email"
                      value={mailEmail}
                      onChange={e => setMailEmail(e.target.value)}
                      placeholder={t('cloud_device.mail_email_placeholder')}
                      className="flex-1"
                    />
                    <span className="text-sm text-text-muted whitespace-nowrap">
                      @staff.sina.com.cn
                    </span>
                  </div>
                  <p className="text-xs text-text-muted">{t('cloud_device.mail_email_hint')}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mail-password" className="text-sm">
                    {t('cloud_device.mail_password')}
                  </Label>
                  <Input
                    id="mail-password"
                    type="password"
                    value={mailpassword}
                    onChange={e => setMailpassword(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Dialog footer with Cancel/Create buttons */}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateConfirm(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" onClick={handleCreateCloudDevice} disabled={isCreating}>
              {isCreating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {t('cloud_device.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
