// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Device Quick Setup Component
 *
 * Simplified cloud device creation flow for first-time users.
 * Shows a single card with optional mail configuration.
 */

'use client'

import '@wecode/i18n'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Cloud, Loader2, Check, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useCloudDevice } from '@wecode/hooks/useCloudDevice'

interface CloudDeviceQuickSetupProps {
  onDeviceCreated: () => void
  onBack: () => void
}

export function CloudDeviceQuickSetup({ onDeviceCreated, onBack }: CloudDeviceQuickSetupProps) {
  const { t } = useTranslation('wecode')
  const { createDevice, isCreating, config } = useCloudDevice()
  const [mailEnabled, setMailEnabled] = useState(false)
  const [mailEmail, setMailEmail] = useState('')
  const [mailpassword, setMailpassword] = useState('')
  const [deviceCreated, setDeviceCreated] = useState(false)

  const handleCreate = async () => {
    try {
      const body =
        mailEnabled && mailEmail && mailpassword
          ? { mail_email: mailEmail, mail_password: mailpassword }
          : undefined
      await createDevice(body)
      toast.success(t('cloud_device.create_success'))
      setDeviceCreated(true)
      // Notify parent to refresh devices
      onDeviceCreated()
    } catch (error: unknown) {
      const apiError = error as { status?: number; message?: string }
      if (apiError?.status === 400) {
        toast.error(t('cloud_device.limit_reached', { max: config?.max_devices_per_user || 1 }))
      } else if (apiError?.status === 503) {
        toast.error(t('cloud_device.not_configured'))
      } else {
        toast.error(t('cloud_device.create_error'))
      }
    }
  }

  // Success state - show device created
  if (deviceCreated) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="w-full max-w-2xl bg-surface border border-primary rounded-xl p-8 text-center">
          {/* Success Icon */}
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-green-600" />
          </div>

          {/* Title */}
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            {t('cloud_device.created_title')}
          </h3>

          {/* Description */}
          <p className="text-sm text-text-muted mb-6">{t('cloud_device.created_description')}</p>

          {/* Start Using Button */}
          <Button variant="primary" onClick={onBack} className="mx-auto">
            {t('cloud_device.start_using')}
          </Button>
        </div>
      </div>
    )
  }

  // Creation form state
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="w-full max-w-2xl">
        {/* Back Button */}
        <div className="mb-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            {t('devices:init_flow.back_to_selection')}
          </Button>
        </div>

        {/* Main Card */}
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Cloud className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">
                {t('cloud_device.quick_setup_title')}
              </h3>
              <p className="text-sm text-text-muted">{t('cloud_device.quick_setup_description')}</p>
            </div>
          </div>

          {/* Mail Configuration Section */}
          <div className="space-y-4 mb-6">
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
                    <span className="text-sm text-text-muted whitespace-nowrap">@staff.sina.com.cn</span>
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

          {/* Action Buttons */}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onBack} disabled={isCreating} className="flex-1">
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={isCreating}
              className="flex-1"
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('cloud_device.creating')}
                </>
              ) : (
                t('cloud_device.create')
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
