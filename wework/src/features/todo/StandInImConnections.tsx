import { Check, MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession, DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInImConnectionDialog } from './StandInImConnectionDialog'

const CHANNELS = ['dingtalk', 'telegram', 'discord', 'weibo'] as const

/** Channel entry points live in the identity popover, outside profile forms. */
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
  const newState = () => ({
    owner: { api, deviceId, roleId },
    sessions: [] as IMPrivateSession[],
    loading: Boolean(api),
    saving: null as string | null,
    error: null as 'load' | 'save' | null,
  })
  const [state, setState] = useState(newState)
  const [channel, setChannel] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [reload, setReload] = useState(0)
  if (
    state.owner.api !== api ||
    state.owner.deviceId !== deviceId ||
    state.owner.roleId !== roleId
  ) {
    setState(newState())
    setChannel(null)
  }
  const { owner, sessions, loading, saving, error } = state
  useEffect(() => {
    if (!api) return
    let active = true
    void api
      .listPrivateSessions()
      .then(result => {
        if (active)
          setState(current =>
            current.owner === owner
              ? { ...current, sessions: result.items, loading: false }
              : current
          )
      })
      .catch(() => {
        if (active)
          setState(current =>
            current.owner === owner ? { ...current, error: 'load', loading: false } : current
          )
      })
    return () => {
      active = false
    }
  }, [api, owner, reload])
  useEffect(() => {
    onOpenChange?.(channel !== null)
    return () => onOpenChange?.(false)
  }, [channel, onOpenChange])

  const connected = (session: IMPrivateSession) =>
    session.mode === 'stand_in' &&
    session.stand_in != null &&
    sameDevice(session.stand_in.deviceId) &&
    (session.stand_in.roleId ?? null) === (roleId ?? null)
  const connect = async (sessionKey: string) => {
    if (!api || saving) return
    setState(current => ({ ...current, saving: sessionKey, error: null }))
    try {
      const binding = await api.bindStandIn(sessionKey, { deviceId, roleId: roleId ?? null })
      setState(current =>
        current.owner === owner
          ? {
              ...current,
              saving: null,
              sessions: current.sessions.map(session =>
                session.session_key === sessionKey
                  ? { ...session, stand_in: binding, mode: 'stand_in' as const }
                  : session
              ),
            }
          : current
      )
    } catch {
      setState(current =>
        current.owner === owner ? { ...current, saving: null, error: 'save' } : current
      )
    }
  }
  const refresh = () => {
    setState(current => ({ ...current, loading: true, error: null }))
    setReload(value => value + 1)
  }
  const channels = [...new Set<string>([...CHANNELS, ...sessions.map(row => row.channel_type)])]
  const label = (type: string) =>
    CHANNELS.includes(type as (typeof CHANNELS)[number])
      ? t(`standIn.im.channels.${type}`)
      : (sessions.find(row => row.channel_type === type)?.channel_label ?? type)
  const device = devices.find(row => sameDevice(row.device_id))
  return (
    <section aria-label={t('standIn.im.title')} data-testid="stand-in-im-channels">
      <div className="flex flex-wrap gap-2">
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
                setState(current =>
                  current.error === 'save' ? { ...current, error: null } : current
                )
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
            onOpenChange?.(false)
            setChannel(null)
            window.requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
          }}
        />
      )}
    </section>
  )
}
