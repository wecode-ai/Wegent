// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import '@wecode/i18n'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cloud, Loader2, Monitor, Server } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { paths } from '@/config/paths'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  formatSlotUsage,
  getSelectableDevices,
  isDeviceAtCapacity,
} from '@/features/devices/utils/execution-target'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { RegisteredModalProps } from '@/lib/scheme/modal-registry'
import { CloudDeviceCreateSection } from '@wecode/components/devices/CloudDeviceCreateSection'

function getCloudMachineCount(devices: DeviceInfo[]) {
  return new Set(
    devices
      .filter(device => device.device_type === 'cloud')
      .map(device => device.cloud_config?.sandboxId ?? device.device_id)
  ).size
}

export function HimalayaAccessGuideDialog({ open, onOpenChange }: RegisteredModalProps) {
  const router = useRouter()
  const { t } = useTranslation('devices')
  const { toast } = useToast()
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [waitingForDevice, setWaitingForDevice] = useState(false)
  const [refreshingDevices, setRefreshingDevices] = useState(false)

  const selectableDevices = useMemo(() => getSelectableDevices(devices), [devices])
  const cloudMachineCount = useMemo(() => getCloudMachineCount(devices), [devices])

  const refreshDeviceList = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading) {
          setLoadingDevices(true)
        } else {
          setRefreshingDevices(true)
        }

        const response = await deviceApis.getAllDevices()
        setDevices(response.items)

        if (getSelectableDevices(response.items).length > 0) {
          setWaitingForDevice(false)
        }
      } catch {
        toast({
          variant: 'destructive',
          title: t('mail_access_guide.load_devices_failed'),
        })
      } finally {
        if (showLoading) {
          setLoadingDevices(false)
        } else {
          setRefreshingDevices(false)
        }
      }
    },
    [t, toast]
  )

  useEffect(() => {
    if (!open) return

    setWaitingForDevice(false)
    void refreshDeviceList(true)
  }, [open, refreshDeviceList])

  useEffect(() => {
    if (!open || !waitingForDevice) return

    const pollDevices = async () => {
      await refreshDeviceList(false)
    }

    const intervalId = window.setInterval(() => {
      void pollDevices()
    }, 5000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [open, waitingForDevice, refreshDeviceList])

  const handleDeviceSelect = (deviceId: string, deviceName: string) => {
    onOpenChange(false)
    router.push(`${paths.devices.getHref()}/chat?deviceId=${encodeURIComponent(deviceId)}`)
    toast({
      title: t('mail_access_guide.switch_success', { deviceName }),
      description: t('mail_access_guide.switch_success_description'),
    })
  }

  const handleDeviceCreated = async () => {
    setWaitingForDevice(true)
    await refreshDeviceList(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mail_access_guide.title')}</DialogTitle>
          <DialogDescription>
            {selectableDevices.length > 0
              ? t('mail_access_guide.description_with_devices')
              : t('mail_access_guide.description_without_devices')}
          </DialogDescription>
        </DialogHeader>

        {loadingDevices ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-5 text-sm text-text-muted">
            {t('mail_access_guide.loading_devices')}
          </div>
        ) : selectableDevices.length > 0 ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="text-sm font-medium text-text-primary">
                {t('mail_access_guide.available_devices')}
              </p>
              <p className="mt-1 text-xs text-text-muted">{t('mail_access_guide.device_help')}</p>
            </div>

            <div className="space-y-2">
              {selectableDevices.map(device => {
                const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)

                return (
                  <button
                    key={device.device_id}
                    type="button"
                    onClick={() => handleDeviceSelect(device.device_id, device.name)}
                    disabled={isFull}
                    data-testid={`himalaya-access-device-${device.device_id}`}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-base px-4 py-3 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {device.device_type === 'cloud' ? (
                      <Server className="h-4 w-4 text-primary" />
                    ) : (
                      <Monitor className="h-4 w-4 text-primary" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {device.name}
                      </p>
                      <p className="text-xs text-text-muted">
                        {t(`mail_access_guide.device_type_${device.device_type}`)} ·{' '}
                        {formatSlotUsage(device.slot_used, device.slot_max)}
                      </p>
                    </div>
                    <span className="inline-flex h-9 min-w-[44px] items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-white">
                      {t('mail_access_guide.switch_action')}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : waitingForDevice ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface px-4 py-8 text-center">
              <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
              <p className="text-sm font-medium text-text-primary">
                {t('mail_access_guide.waiting_title')}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {t('wecode:cloud_device.creating_notice')}
              </p>
            </div>
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshDeviceList(false)}
                disabled={refreshingDevices}
                className="h-10 min-w-[44px]"
              >
                {refreshingDevices ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t('mail_access_guide.refresh_action')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-5 text-center">
              <Cloud className="mx-auto mb-3 h-10 w-10 text-primary" />
              <p className="text-sm font-medium text-text-primary">
                {t('mail_access_guide.no_devices_title')}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {t('mail_access_guide.no_devices_description')}
              </p>
            </div>
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshDeviceList(false)}
                disabled={refreshingDevices}
                className="h-10 min-w-[44px]"
              >
                {refreshingDevices ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t('mail_access_guide.refresh_action')}
              </Button>
            </div>

            <CloudDeviceCreateSection
              onDeviceCreated={() => {
                void handleDeviceCreated()
              }}
              currentDeviceCount={cloudMachineCount}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
