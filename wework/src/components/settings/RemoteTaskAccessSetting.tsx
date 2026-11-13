import { useEffect, useRef, useState } from 'react'
import { getRemoteTaskAccess, setRemoteTaskAccess } from '@/desktop/remoteTaskAccess'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './settings-ui'

export function RemoteTaskAccessSetting() {
  const { t } = useTranslation('common')
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const revision = useRef(0)
  const savingRef = useRef(false)

  useEffect(() => {
    let active = true
    const refresh = () => {
      if (savingRef.current) return
      const request = ++revision.current
      setLoading(true)
      setLoaded(false)
      void getRemoteTaskAccess().then(
        settings => {
          if (!active || request !== revision.current) return
          setEnabled(settings.enabled)
          setLoaded(true)
          setError(null)
          setLoading(false)
        },
        () => {
          if (!active || request !== revision.current) return
          setError(t('workbench.remote_task_access_load_failed'))
          setLoading(false)
        }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      revision.current += 1
      window.removeEventListener('focus', refresh)
    }
  }, [t])

  const save = async (next: boolean) => {
    const request = ++revision.current
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const settings = await setRemoteTaskAccess(next)
      if (request === revision.current) setEnabled(settings.enabled)
    } catch {
      if (request === revision.current) setError(t('workbench.remote_task_access_save_failed'))
    } finally {
      savingRef.current = false
      if (request === revision.current) setSaving(false)
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
        <p role="alert" className="mt-2 text-sm text-red-500">
          {error}
        </p>
      ) : null}
    </section>
  )
}
