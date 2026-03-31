// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Fragment, useContext, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { taskApis } from '@/apis/tasks'
import { userApis } from '@/apis/user'
import { TaskContext } from '@/features/tasks/contexts/taskContext'
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
import type { ModalParams, RegisteredModalProps } from '@/lib/scheme/modal-registry'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { mailApis, type MailDomain } from '@wecode/apis'

const EMAIL_DOMAIN_OPTIONS: MailDomain[] = ['@staff.sina.com.cn', '@staff.weibo.com']
const ONLINE_DEVICE_STATUSES = new Set<DeviceInfo['status']>(['online', 'busy'])

function getSelectableDevices(devices: DeviceInfo[]) {
  return devices
    .filter(device => ONLINE_DEVICE_STATUSES.has(device.status))
    .sort((left, right) => {
      if (left.is_default !== right.is_default) {
        return left.is_default ? -1 : 1
      }
      if (left.device_type !== right.device_type) {
        return left.device_type === 'local' ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
}

function getPreferredDevice(devices: DeviceInfo[]) {
  return getSelectableDevices(devices)[0] || null
}

function formatSlotUsage(slotUsed: number, slotMax: number) {
  return slotMax > 0 ? `${slotUsed}/${slotMax}` : `${slotUsed}/∞`
}

function getStringParam(params: ModalParams | undefined, key: string): string {
  const value = params?.[key]
  return typeof value === 'string' ? value : ''
}

function getCurrentDeviceId(params: ModalParams | undefined, taskDeviceId?: string | null): string {
  // Priority 1: device_id from current task context (task is bound to a specific device)
  if (taskDeviceId) {
    return taskDeviceId
  }

  // Priority 2: device_id from modal params
  const paramDeviceId = getStringParam(params, 'deviceId') || getStringParam(params, 'device_id')
  if (paramDeviceId) {
    return paramDeviceId
  }

  // Priority 3: device_id from URL query params
  if (typeof window === 'undefined') {
    return ''
  }

  const searchParams = new URLSearchParams(window.location.search)
  return searchParams.get('deviceId') || searchParams.get('device_id') || ''
}

function getCurrentTaskId(params: ModalParams | undefined): number | null {
  const paramTaskId =
    getStringParam(params, 'taskId') ||
    getStringParam(params, 'task_id') ||
    getStringParam(params, 'taskid')

  let value = paramTaskId
  if (!value && typeof window !== 'undefined') {
    const searchParams = new URLSearchParams(window.location.search)
    value =
      searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid') || ''
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function formatDeviceOptionLabel(device: DeviceInfo, t: (key: string) => string) {
  const typeLabel =
    device.device_type === 'cloud'
      ? t('mail_config.device_type_cloud')
      : t('mail_config.device_type_local')
  return `${device.name} · ${typeLabel} · ${formatSlotUsage(device.slot_used, device.slot_max)}`
}

function formatCurrentDeviceLabel(device: DeviceInfo) {
  return device.name
}

export function MailConfigDialog({ open, onOpenChange, params }: RegisteredModalProps) {
  const { t } = useTranslation('devices')
  const { toast } = useToast()
  // Get task context if available (may be null if used outside TaskContextProvider)
  const taskContext = useContext(TaskContext)
  const [loadingIdentity, setLoadingIdentity] = useState(false)
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [saving, setSaving] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [lockedDeviceId, setLockedDeviceId] = useState('')
  const [accountPrefix, setAccountPrefix] = useState('')
  const [emailDomain, setEmailDomain] = useState<MailDomain>('@staff.sina.com.cn')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [taskId, setTaskId] = useState<number | null>(null)

  const selectableDevices = useMemo(() => getSelectableDevices(devices), [devices])
  const resolvedAccountPrefix = accountPrefix.trim()
  const lockedDevice = useMemo(
    () => selectableDevices.find(device => device.device_id === lockedDeviceId) || null,
    [lockedDeviceId, selectableDevices]
  )
  const currentSelectedDevice = useMemo(
    () => selectableDevices.find(device => device.device_id === selectedDeviceId) || null,
    [selectedDeviceId, selectableDevices]
  )
  const shouldLockToCurrentDevice = Boolean(lockedDevice)

  useEffect(() => {
    if (!open) return

    const currentTaskId = getCurrentTaskId(params)
    setTaskId(currentTaskId)

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

    const loadTaskDeviceId = async () => {
      // Try to get device_id from task context first
      const contextDeviceId = taskContext?.selectedTaskDetail?.device_id
      if (contextDeviceId) {
        return contextDeviceId
      }

      // If not in context, fetch from API
      if (currentTaskId) {
        try {
          const taskDetail = await taskApis.getTaskDetail(currentTaskId)
          if (taskDetail.device_id) {
            return taskDetail.device_id
          }
        } catch {
          // Ignore error, will fall back to device selection
        }
      }
      return null
    }

    const loadDevices = async (resolvedTaskDeviceId: string | null) => {
      try {
        setLoadingDevices(true)
        const response = await deviceApis.getAllDevices()
        setDevices(response.items)

        const currentDeviceId = getCurrentDeviceId(params, resolvedTaskDeviceId)
        const selectableItems = getSelectableDevices(response.items)
        const currentDevice = selectableItems.find(device => device.device_id === currentDeviceId)
        const preferredDevice = currentDevice || getPreferredDevice(response.items)

        setLockedDeviceId(currentDevice?.device_id || '')
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
    setLockedDeviceId('')
    setEmailDomain('@staff.sina.com.cn')

    void loadIdentity()
    void loadTaskDeviceId().then(loadDevices)
  }, [open, params, taskContext?.selectedTaskDetail?.device_id, t, toast])

  const handleSave = async () => {
    if (!selectedDeviceId || !password || !resolvedAccountPrefix || !taskId) {
      if (!taskId) {
        toast({
          variant: 'destructive',
          title: t('mail_config.no_task_context'),
        })
      }
      return
    }

    try {
      setSaving(true)
      await mailApis.createConfig(selectedDeviceId, {
        task_id: taskId,
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
    !resolvedAccountPrefix ||
    !taskId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('mail_config.title')}</DialogTitle>
          <DialogDescription>{t('mail_config.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            {shouldLockToCurrentDevice ? (
              <div className="flex items-center gap-3">
                <Label className="w-20 shrink-0 text-sm font-medium text-text-primary">
                  {t('mail_config.current_device_label')}
                </Label>
                <div
                  id="mail-current-device"
                  className="flex-1 min-h-[44px] rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary"
                  data-testid="mail-current-device-input"
                >
                  {lockedDevice ? formatCurrentDeviceLabel(lockedDevice) : ''}
                </div>
              </div>
            ) : (
              <Fragment>
                <Label htmlFor="mail-device-select">{t('mail_config.device_label')}</Label>
                <Select
                  value={selectedDeviceId}
                  onValueChange={setSelectedDeviceId}
                  disabled={loadingDevices || saving || selectableDevices.length === 0}
                >
                  <SelectTrigger
                    id="mail-device-select"
                    className="h-11 min-w-[44px]"
                    data-testid="mail-device-select"
                  >
                    <SelectValue placeholder={t('mail_config.device_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableDevices.map(device => (
                      <SelectItem key={device.device_id} value={device.device_id}>
                        {formatDeviceOptionLabel(device, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Fragment>
            )}
            {!shouldLockToCurrentDevice && selectableDevices.length === 0 ? (
              <p className="text-xs text-text-muted">{t('mail_config.no_devices')}</p>
            ) : null}
            {!taskId ? (
              <p className="text-xs text-text-muted">{t('mail_config.no_task_context')}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <Label
              htmlFor="mail-account-input"
              className="w-20 shrink-0 text-sm font-medium text-text-primary"
            >
              {t('mail_config.account_label')}
            </Label>
            <div className="flex flex-1 gap-2">
              <Input
                id="mail-account-input"
                type="text"
                value={accountPrefix}
                readOnly
                placeholder={loadingIdentity ? t('mail_config.loading_account') : ''}
                autoComplete="username"
                disabled={saving || loadingIdentity}
                data-testid="mail-account-input"
              />
              <Select
                value={emailDomain}
                onValueChange={value => setEmailDomain(value as MailDomain)}
                disabled={saving}
              >
                <SelectTrigger
                  className="h-11 w-[220px] min-w-[44px]"
                  data-testid="mail-email-domain-select"
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
              htmlFor="mail-password-input"
              className="w-20 shrink-0 text-sm font-medium text-text-primary"
            >
              {t('mail_config.password_label')}
            </Label>
            <div className="relative flex-1">
              <Input
                id="mail-password-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder={t('mail_config.password_placeholder')}
                autoComplete="current-password"
                disabled={
                  loadingDevices ||
                  saving ||
                  !taskId ||
                  (!currentSelectedDevice && selectableDevices.length === 0)
                }
                className="pr-10"
                data-testid="mail-password-input"
              />
              <button
                type="button"
                aria-label={
                  showPassword ? t('mail_config.hide_password') : t('mail_config.show_password')
                }
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-secondary"
                onClick={() => setShowPassword(value => !value)}
                disabled={
                  loadingDevices ||
                  saving ||
                  !taskId ||
                  (!currentSelectedDevice && selectableDevices.length === 0)
                }
                data-testid="toggle-mail-password-visibility-button"
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
            data-testid="cancel-mail-config-button"
          >
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={isSaveDisabled}
            data-testid="save-mail-config-button"
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
