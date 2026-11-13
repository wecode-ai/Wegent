import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getRemoteTaskAccess, setRemoteTaskAccess } from '@/desktop/remoteTaskAccess'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './settings-ui'

export function RemoteTaskAccessSetting() {
  const { t } = useTranslation('common')
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const [loaded, setLoaded] = useState(false)
  const revision = useRef(0)
  const savingRef = useRef(false)

  const refresh = useCallback(() => {
    if (savingRef.current) return
    const request = ++revision.current
    setLoading(true)
    setLoaded(false)
    setError(null)
    void getRemoteTaskAccess().then(
      settings => {
        if (request !== revision.current) return
        setEnabled(settings.enabled)
        setLoaded(true)
        setLoading(false)
      },
      () => {
        if (request !== revision.current) return
        setError('load')
        setLoading(false)
      }
    )
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      revision.current += 1
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const save = async (next: boolean) => {
    const request = ++revision.current
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const settings = await setRemoteTaskAccess(next)
      if (request === revision.current) setEnabled(settings.enabled)
    } catch {
      if (request === revision.current) setError('save')
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
