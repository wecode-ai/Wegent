import { Check, ChevronRight, Gamepad2, MessageCircle, Radio, Send, Zap } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { createStandInImConnectionSource } from './standInImConnectionSource'
import { Button } from '@/components/ui/button'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession, DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImConnectionDialog } from './StandInImConnectionDialog'

const CHANNEL_ICONS = new Map([
  ['dingtalk', Zap],
  ['telegram', Send],
  ['discord', Gamepad2],
  ['weibo', Radio],
])

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
  const { sessions, loading, saving, error, channel } = useSyncExternalStore(
    subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  const content = useRef<HTMLDivElement | null>(null)
  const focusTarget = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<object>()
  useFocusRequest(focusTarget, focusRequest, {
    enabled: focusRequest !== undefined,
    animationFrame: true,
    preventScroll: true,
  })
  const setChannel = source.setChannel
  const connected = (session: IMPrivateSession) =>
    session.mode === 'stand_in' &&
    session.stand_in != null &&
    sameDevice(session.stand_in.deviceId) &&
    (session.stand_in.roleId ?? null) === (roleId ?? null)
  const connect = source.connect
  const refresh = source.refresh
  const channels = [...new Set([...CHANNEL_ICONS.keys(), ...sessions.map(row => row.channel_type)])]
  const label = (type: string) =>
    CHANNEL_ICONS.has(type)
      ? t(`standIn.im.channels.${type}`)
      : (sessions.find(row => row.channel_type === type)?.channel_label ?? type)
  const device = devices.find(row => sameDevice(row.device_id))
  return (
    <div ref={content} className="space-y-3">
      <p className="text-sm text-text-secondary">{t('standIn.im.settings_help')}</p>
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
      <ul className="divide-y divide-border rounded-xl border border-border">
        {channels.map(type => {
          const isConnected = sessions.some(row => row.channel_type === type && connected(row))
          const Icon = CHANNEL_ICONS.get(type) ?? MessageCircle
          return (
            <li key={type} className="first:rounded-t-[inherit] last:rounded-b-[inherit]">
              <Button
                variant="ghost"
                className="flex min-h-11 w-full justify-start gap-3 rounded-[inherit] px-3 py-2 text-left keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-offset-0"
                data-testid={`stand-in-im-channel-${type}`}
                aria-haspopup="dialog"
                onClick={() => setChannel(type)}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-text-secondary">
                  <Icon aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 whitespace-normal break-words">{label(type)}</span>
                {isConnected && (
                  <span className="flex items-center gap-1 text-xs text-text-secondary">
                    <Check aria-hidden="true" />
                    {t('standIn.im.connected')}
                  </span>
                )}
                <ChevronRight aria-hidden="true" className="text-text-secondary" />
              </Button>
            </li>
          )
        })}
      </ul>
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
            focusTarget.current = availableTrigger ?? null
            setChannel(null)
            setFocusRequest({})
          }}
        />
      )}
    </div>
  )
}
