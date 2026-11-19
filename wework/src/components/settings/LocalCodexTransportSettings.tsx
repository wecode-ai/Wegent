import { useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  getLocalCodexTransport,
  saveLocalCodexTransport,
  type LocalCodexTransport,
} from '@/features/model-settings/localCodexSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsRow, SettingsSegmentedControl } from './settings-ui'

const transportOptions = [
  { value: 'http', label: 'HTTP', testId: 'local-codex-transport-http' },
  { value: 'websocket', label: 'WebSocket', testId: 'local-codex-transport-websocket' },
] as const

export function LocalCodexTransportSettings() {
  const { t } = useTranslation('common')
  const [resource] = useState(() => createAsyncResource('codex/transport', getLocalCodexTransport))
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const label = t('workbench.local_codex_transport_title')

  const changeTransport = async (transport: LocalCodexTransport) => {
    if (saving || transport === snapshot.data) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await saveLocalCodexTransport(transport)
      resource.update(() => transport)
    } catch {
      setSaveFailed(true)
      await resource.reload()
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow
      label={label}
      description={
        <>
          {t('workbench.local_codex_transport_description')}
          {saveFailed && (
            <span role="alert" className="mt-1 block text-error">
              {t('workbench.local_codex_transport_save_failed')}
            </span>
          )}
          {snapshot.status === 'error' && (
            <span role="alert" className="mt-1 block text-error">
              {t('workbench.local_codex_transport_load_failed')}
            </span>
          )}
        </>
      }
      control={
        snapshot.status === 'error' ? (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="local-codex-transport-retry"
            onClick={() => void resource.reload()}
          >
            {t('common.retry')}
          </button>
        ) : (
          <SettingsSegmentedControl
            label={label}
            value={snapshot.data ?? ''}
            options={transportOptions}
            disabled={snapshot.status !== 'ready' || saving}
            onChange={transport => {
              if (transport) void changeTransport(transport)
            }}
          />
        )
      }
    />
  )
}
