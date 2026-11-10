import { getUnambiguousWorkbenchDeviceAliases } from '@/lib/workbench-device'
import { useEffect, useState } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession, DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

/** IM bindings are saved independently from the stand-in's source subscriptions. */
export function StandInImConnections({
  services,
  deviceId,
  roleId,
  disabled = false,
  devices = [],
}: {
  services: WorkbenchServices
  deviceId: string
  roleId?: string
  disabled?: boolean
  devices?: DeviceInfo[]
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
  const [reload, setReload] = useState(0)
  if (
    state.owner.api !== api ||
    state.owner.deviceId !== deviceId ||
    state.owner.roleId !== roleId
  ) {
    setState(newState())
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

  const connect = async (sessionKey: string) => {
    if (!api) return
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
  return (
    <section className="space-y-2 py-4" data-testid="stand-in-im-connections">
      <h2 className="font-medium">{t('standIn.im.title')}</h2>
      <p className="text-xs text-text-muted">{t('standIn.im.description')}</p>
      {!services.imSessionApi ? (
        <p className="text-sm text-text-muted">{t('standIn.im.sign_in')}</p>
      ) : (
        <>
          {loading && (
            <p role="status" className="text-sm text-text-muted">
              {t('standIn.im.loading')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-error">
              {t(error === 'load' ? 'standIn.im.load_failed' : 'standIn.im.save_failed')}
            </p>
          )}
          {!loading && !error && !sessions.length && (
            <p className="text-sm text-text-muted">{t('standIn.im.empty')}</p>
          )}
          {sessions.map(session => {
            const connected =
              session.mode === 'stand_in' &&
              session.stand_in != null &&
              sameDevice(session.stand_in.deviceId) &&
              (session.stand_in.roleId ?? null) === (roleId ?? null)
            return (
              <div key={session.session_key} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {session.channel_label} · {session.display_name || session.sender_id}
                  </p>
                  <p className="text-xs text-text-muted">
                    {t(
                      session.mode !== 'stand_in'
                        ? 'standIn.im.chat_mode'
                        : connected
                          ? 'standIn.im.connected'
                          : session.stand_in
                            ? 'standIn.im.other'
                            : 'standIn.im.default'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`stand-in-im-connect-${session.session_key}`}
                  className="min-h-11 shrink-0 rounded-md border border-border px-3 py-1 text-sm hover:bg-surface disabled:opacity-50 md:min-h-0"
                  disabled={disabled || loading || Boolean(saving) || connected}
                  onClick={() => void connect(session.session_key)}
                >
                  {t(
                    saving === session.session_key
                      ? 'standIn.im.saving'
                      : connected
                        ? 'standIn.im.connected'
                        : 'standIn.im.connect'
                  )}
                </button>
              </div>
            )
          })}
          <button
            type="button"
            data-testid="stand-in-im-refresh"
            className="min-h-11 text-sm text-text-secondary hover:underline md:min-h-0"
            disabled={loading || Boolean(saving)}
            onClick={refresh}
          >
            {t('standIn.im.refresh')}
          </button>
        </>
      )}
    </section>
  )
}
