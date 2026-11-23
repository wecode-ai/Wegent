import { Check, ChevronDown, MessageSquare } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { createStandInImConnectionSource } from './standInImConnectionSource'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Button } from '@/components/ui/button'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession, DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImConnectionDialog } from './StandInImConnectionDialog'

const CHANNELS = ['dingtalk', 'telegram', 'discord', 'weibo'] as const

export function StandInImConnections({
  services,
  deviceId,
  roleId,
  name,
  devices = [],
  onOpenChange,
}: {
  services: WorkbenchServices
  deviceId: string
  roleId?: string
  name: string
  devices?: DeviceInfo[]
  onOpenChange?(open: boolean): void
}) {
  const { t } = useTranslation('common')
  const aliases = getUnambiguousWorkbenchDeviceAliases(devices)
  const sameDevice = (bound: string) =>
    (aliases.get(bound) ?? bound) === (aliases.get(deviceId) ?? deviceId)
  const api = services.imSessionApi
  const source = useMemo(
    () => createStandInImConnectionSource(api, deviceId, roleId),
    [api, deviceId, roleId]
  )
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, onOpenChange),
    [source, onOpenChange]
  )
  const { sessions, loading, saving, error, channel, menuOpen } = useSyncExternalStore(
    subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  const trigger = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const focusTarget = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<object>()
  useFocusRequest(focusTarget, focusRequest, {
    enabled: focusRequest !== undefined,
    animationFrame: true,
    preventScroll: true,
  })
  const setChannel = source.setChannel
  const setMenuOpen = source.setMenuOpen
  const connected = (session: IMPrivateSession) =>
    session.mode === 'stand_in' &&
    session.stand_in != null &&
    sameDevice(session.stand_in.deviceId) &&
    (session.stand_in.roleId ?? null) === (roleId ?? null)
  const connect = source.connect
  const refresh = source.refresh
  const channels = [...new Set(sessions.map(row => row.channel_type))]
  const availableToAdd = CHANNELS.filter(type => !channels.includes(type))
  const label = (type: string) =>
    CHANNELS.includes(type as (typeof CHANNELS)[number])
      ? t(`standIn.im.channels.${type}`)
      : (sessions.find(row => row.channel_type === type)?.channel_label ?? type)
  const device = devices.find(row => sameDevice(row.device_id))
  return (
    <div ref={content} className="space-y-2">
      <div className="flex justify-end empty:hidden">
        {!loading && error !== 'load' && (availableToAdd.length > 0 || menuOpen) && (
          <ActionMenu
            ariaLabel={t('standIn.im.add_channels')}
            testId="stand-in-im-add-channels"
            placement="bottom-end"
            itemClassName="max-md:min-h-11"
            density="default"
            triggerLabel={
              <>
                {t('standIn.im.add_channels_action')}
                <ChevronDown aria-hidden="true" className="h-4 w-4" />
              </>
            }
            triggerClassName="shrink-0 gap-2 px-0 text-sm"
            onOpenChange={setMenuOpen}
            items={availableToAdd.map(type => ({
              label: t('standIn.im.add_channel', { channel: label(type) }),
              icon: MessageSquare,
              testId: `stand-in-im-channel-${type}`,
              onSelect: () => {
                trigger.current =
                  content.current?.querySelector<HTMLButtonElement>(
                    '[data-testid="stand-in-im-add-channels"]'
                  ) ?? null
                setChannel(type)
              },
            }))}
          />
        )}
      </div>
      {loading && (
        <p
          role="status"
          data-testid="stand-in-im-discovery-loading"
          className="text-sm text-text-secondary"
        >
          {t('standIn.im.loading')}
        </p>
      )}
      {error === 'load' && (
        <div
          role="alert"
          data-testid="stand-in-im-discovery-error"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-error">{t('standIn.im.load_failed')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-im-discovery-retry"
            onClick={refresh}
          >
            {t('standIn.im.refresh')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {channels.map(type => {
          const isConnected = sessions.some(row => row.channel_type === type && connected(row))
          return (
            <Button
              key={type}
              variant="secondary"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid={`stand-in-im-channel-${type}`}
              aria-haspopup="dialog"
              aria-label={t('standIn.im.channel_action', { channel: label(type) })}
              onClick={event => {
                trigger.current = event.currentTarget
                setChannel(type)
              }}
            >
              {isConnected ? <Check aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
              {label(type)}
              {isConnected && <span className="sr-only">{t('standIn.im.connected')}</span>}
            </Button>
          )
        })}
      </div>
      {channel !== null && (
        <StandInImConnectionDialog
          key={JSON.stringify([deviceId, roleId, channel])}
          channel={label(channel)}
          name={name}
          deviceName={device?.name}
          offline={device?.status === 'offline'}
          signedIn={Boolean(api)}
          sessions={sessions.filter(row => row.channel_type === channel)}
          loading={loading}
          saving={saving}
          error={error}
          connected={connected}
          onConnect={connect}
          onRefresh={refresh}
          onClose={() => {
            // Release the popover's inert state before restoring its trigger focus.
            const availableTrigger = Array.from(
              content.current?.querySelectorAll('button') ?? []
            ).find(button => button.dataset.testid === `stand-in-im-channel-${channel}`)
            focusTarget.current =
              availableTrigger ??
              content.current?.querySelector<HTMLButtonElement>(
                '[data-testid="stand-in-im-add-channels"]'
              ) ??
              content.current?.querySelector<HTMLButtonElement>(
                '[data-testid="stand-in-im-discovery-retry"]'
              ) ??
              (trigger.current?.isConnected ? trigger.current : null)
            setChannel(null)
            setFocusRequest({})
          }}
        />
      )}
    </div>
  )
}
