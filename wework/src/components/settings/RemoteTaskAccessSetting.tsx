import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { getRemoteTaskAccess, setRemoteTaskAccess } from '@/desktop/remoteTaskAccess'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './settings-ui'

export function RemoteTaskAccessSetting() {
  const { t } = useTranslation('common')
  const resource = useMemo(
    () =>
      createAsyncResource('remote-task-access', async () => (await getRemoteTaskAccess()).enabled),
    []
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const enabled = snapshot.data ?? false
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const loaded = snapshot.status === 'ready'
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const savingRef = useRef(false)
  const error = saveError ? 'save' : snapshot.status === 'error' ? 'load' : null
  const refresh = useCallback(() => {
    if (savingRef.current) return
    setSaveError(false)
    void resource.reload()
  }, [resource])
  useWindowEvent('focus', refresh)

  const save = async (next: boolean) => {
    savingRef.current = true
    setSaving(true)
    setSaveError(false)
    resource.update(value => value)
    try {
      const settings = await setRemoteTaskAccess(next)
      resource.update(() => settings.enabled)
    } catch {
      setSaveError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section className="mt-4" data-testid="remote-task-access-setting">
      <SettingsGroup>
        <SettingsRow
          label={t('workbench.remote_task_access_title')}
          description={t('workbench.remote_task_access_description')}
          control={
            <SettingsSwitch
              data-testid="remote-task-access-toggle"
              checked={enabled}
              disabled={loading || !loaded || saving}
              aria-label={t('workbench.remote_task_access_title')}
              onCheckedChange={next => void save(next)}
            />
          }
        />
      </SettingsGroup>
      {error ? (
        <div role="alert" className="mt-2 flex items-center gap-2 text-sm text-destructive">
          {t(`workbench.remote_task_access_${error}_failed`)}
          {error === 'load' ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="remote-task-access-retry"
              onClick={refresh}
              disabled={loading || saving}
            >
              {t('workbench.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
