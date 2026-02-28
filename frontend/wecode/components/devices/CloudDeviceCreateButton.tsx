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
  const [mailEnabled, setMailEnabled] = useState(false)
  const [mailEmail, setMailEmail] = useState('')
  const [mailpassword, setMailpassword] = useState('')

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
      <Dialog
        open={showConfirm}
        onOpenChange={open => {
          setShowConfirm(open)
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
                id="header-mail-enable"
                checked={mailEnabled}
                onCheckedChange={checked => setMailEnabled(checked === true)}
              />
              <Label htmlFor="header-mail-enable" className="text-sm font-medium cursor-pointer">
                {t('cloud_device.mail_enable')}
              </Label>
            </div>
            {mailEnabled && (
              <div className="space-y-3 pl-6">
                <div className="space-y-1">
                  <Label htmlFor="header-mail-email" className="text-sm">
                    {t('cloud_device.mail_email')}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="header-mail-email"
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
                  <Label htmlFor="header-mail-password" className="text-sm">
                    {t('cloud_device.mail_password')}
                  </Label>
                  <Input
                    id="header-mail-password"
                    type="password"
                    value={mailpassword}
                    onChange={e => setMailpassword(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" onClick={handleCreate}>
              {t('cloud_device.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
