// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { userApis } from '@/apis/user'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RegisteredModalProps } from '@/lib/scheme/modal-registry'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { himalayaMailApis, type HimalayaMailDomain } from '@wecode/apis'

const EMAIL_DOMAIN_OPTIONS: HimalayaMailDomain[] = ['@staff.sina.com.cn', '@staff.weibo.com']
const ONLINE_DEVICE_STATUSES = new Set<DeviceInfo['status']>(['online', 'busy'])

function getSelectableLocalDevices(devices: DeviceInfo[]) {
  return devices
    .filter(device => device.device_type === 'local' && ONLINE_DEVICE_STATUSES.has(device.status))
    .sort((left, right) => {
      if (left.is_default !== right.is_default) {
        return left.is_default ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
}

function getPreferredLocalDevice(devices: DeviceInfo[]) {
  return getSelectableLocalDevices(devices)[0] || null
}

function formatSlotUsage(slotUsed: number, slotMax: number) {
  return slotMax > 0 ? `${slotUsed}/${slotMax}` : `${slotUsed}/∞`
}

export function HimalayaMailConfigDialog({ open, onOpenChange }: RegisteredModalProps) {
  const { t } = useTranslation('devices')
  const { toast } = useToast()
  const [loadingIdentity, setLoadingIdentity] = useState(false)
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [saving, setSaving] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [accountPrefix, setAccountPrefix] = useState('')
  const [emailDomain, setEmailDomain] = useState<HimalayaMailDomain>('@staff.sina.com.cn')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const selectableDevices = useMemo(() => getSelectableLocalDevices(devices), [devices])
  const resolvedAccountPrefix = accountPrefix.trim()

  useEffect(() => {
    if (!open) return

    const loadIdentity = async () => {
      try {
        setLoadingIdentity(true)
        const currentUser = await userApis.getCurrentUser()
        setAccountPrefix(currentUser.user_name.trim())
      } catch {
        toast({
          variant: 'destructive',
          title: t('mail_config.load_user_failed'),
        })
      } finally {
        setLoadingIdentity(false)
      }
    }

    const loadDevices = async () => {
      try {
        setLoadingDevices(true)
        const response = await deviceApis.getAllDevices()
        setDevices(response.items)

        const preferredDevice = getPreferredLocalDevice(response.items)
        setSelectedDeviceId(preferredDevice?.device_id || '')
      } catch {
        toast({
          variant: 'destructive',
          title: t('mail_config.load_devices_failed'),
        })
      } finally {
        setLoadingDevices(false)
      }
    }

    setPassword('')
    setShowPassword(false)
    setAccountPrefix('')
    setEmailDomain('@staff.sina.com.cn')
    void loadIdentity()
    void loadDevices()
  }, [open, t, toast])

  const handleSave = async () => {
    if (!selectedDeviceId || !password || !resolvedAccountPrefix) {
      return
    }

    try {
      setSaving(true)
      await himalayaMailApis.createConfig(selectedDeviceId, {
        account_prefix: resolvedAccountPrefix,
        email_domain: emailDomain,
        password,
      })

      toast({
        title: t('mail_config.save_success'),
        description: t('mail_config.retry_hint'),
      })
      onOpenChange(false)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('mail_config.save_failed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const isSaveDisabled =
    loadingDevices ||
    loadingIdentity ||
    saving ||
    !selectedDeviceId ||
    !password ||
    !resolvedAccountPrefix

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('mail_config.title')}</DialogTitle>
          <DialogDescription>{t('mail_config.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="himalaya-mail-device-select">{t('mail_config.device_label')}</Label>
            <Select
              value={selectedDeviceId}
              onValueChange={setSelectedDeviceId}
              disabled={loadingDevices || saving || selectableDevices.length === 0}
            >
              <SelectTrigger
                id="himalaya-mail-device-select"
                className="h-11 min-w-[44px]"
                data-testid="himalaya-mail-device-select"
              >
                <SelectValue placeholder={t('mail_config.device_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {selectableDevices.map(device => (
                  <SelectItem key={device.device_id} value={device.device_id}>
                    {`${device.name} · ${formatSlotUsage(device.slot_used, device.slot_max)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectableDevices.length === 0 ? (
              <p className="text-xs text-text-muted">{t('mail_config.no_local_devices')}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <Label
              htmlFor="himalaya-mail-account-input"
              className="w-20 shrink-0 text-sm font-medium text-text-primary"
            >
              {t('mail_config.account_label')}
            </Label>
            <div className="flex flex-1 gap-2">
              <Input
                id="himalaya-mail-account-input"
                type="text"
                value={accountPrefix}
                readOnly
                placeholder={loadingIdentity ? t('mail_config.loading_account') : ''}
                autoComplete="username"
                disabled={saving || loadingIdentity}
                data-testid="himalaya-mail-account-input"
              />
              <Select
                value={emailDomain}
                onValueChange={value => setEmailDomain(value as HimalayaMailDomain)}
                disabled={saving}
              >
                <SelectTrigger
                  className="h-11 w-[220px] min-w-[44px]"
                  data-testid="himalaya-mail-email-domain-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMAIL_DOMAIN_OPTIONS.map(option => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Label
              htmlFor="himalaya-mail-password-input"
              className="w-20 shrink-0 text-sm font-medium text-text-primary"
            >
              {t('mail_config.password_label')}
            </Label>
            <div className="relative flex-1">
              <Input
                id="himalaya-mail-password-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder={t('mail_config.password_placeholder')}
                autoComplete="current-password"
                disabled={loadingDevices || saving}
                className="pr-10"
                data-testid="himalaya-mail-password-input"
              />
              <button
                type="button"
                aria-label={
                  showPassword ? t('mail_config.hide_password') : t('mail_config.show_password')
                }
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-secondary"
                onClick={() => setShowPassword(value => !value)}
                disabled={loadingDevices || saving}
                data-testid="toggle-himalaya-mail-password-visibility-button"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            data-testid="cancel-himalaya-mail-config-button"
          >
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={isSaveDisabled}
            data-testid="save-himalaya-mail-config-button"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('mail_config.saving')}
              </>
            ) : (
              t('mail_config.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
