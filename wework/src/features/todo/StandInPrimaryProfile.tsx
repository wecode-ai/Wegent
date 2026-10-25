import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { dequal } from 'dequal'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { CollaborationProject } from '@wegent/collaboration'
import { StandInConnectionSettings } from './StandInConnectionSettings'
import { StandInComposer } from './StandInComposer'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

export function StandInPrimaryProfile({
  settings,
  saving,
  error,
  onSave,
  onClose,
  api,
  localDeviceId,
  projects,
  services,
  devices,
  onSelectDevice,
}: {
  settings: PersonalStandInSettings
  saving: boolean
  error: string | null
  onSave(settings: PersonalStandInSettings): Promise<void>
  onClose(): void
  api?: StandInExecutorApi
  localDeviceId: string
  projects: CollaborationProject[]
  services: WorkbenchServices
  devices: DeviceInfo[]
  onSelectDevice(deviceId: string): void
}) {
  const { t } = useTranslation('common')
  const saved = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  // Consolidate the old two-field profile without dropping either saved value.
  const original = {
    ...saved,
    prompt: '',
    preferences: [saved.prompt, saved.preferences].filter(Boolean).join('\n\n'),
  }
  const [draft, setDraft] = useState(original)
  const [discard, setDiscard] = useState(false)
  const [runtimeWork, setRuntimeWork] = useState<RuntimeWorkListResponse | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!services.runtimeWorkApi) return
    let active = true
    void services.runtimeWorkApi
      .listRuntimeWork({ deviceId: settings.executionDeviceId })
      .then(value => {
        if (active) {
          setRuntimeWork(value)
          setRuntimeError(null)
        }
      })
      .catch(cause => {
        if (active) setRuntimeError(String(cause))
      })
    return () => {
      active = false
    }
  }, [services.runtimeWorkApi, settings.executionDeviceId, reload])
  const dirty = !dequal(original, draft)
  const role = {
    ...newStandInRole(settings.executionDeviceId, 'primary'),
    ...draft,
    collaboration: draft.collaboration ?? newStandInRole(settings.executionDeviceId).collaboration,
  }
  const close = () => {
    if (saving) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close)
  return (
    <div
      ref={dialogRef}
      className="flex min-h-full flex-col px-5"
      data-testid="stand-in-primary-profile"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
    >
      <header className="sticky top-0 z-10 mb-5 flex items-center gap-3 border-b border-border bg-background py-4">
        <h2 className="heading-sm flex-1">{t('standIn.workspace.primary_profile')}</h2>
        <button
          type="button"
          data-testid="stand-in-primary-profile-close"
          aria-label={t('standIn.close')}
          disabled={saving}
          onClick={close}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <label className="mb-5 flex min-h-9 items-center justify-between gap-3">
        <span>{t('standIn.workspace.receive_new')}</span>
        <input
          type="checkbox"
          data-testid="stand-in-primary-enabled"
          checked={draft.enabled}
          disabled={saving}
          onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
          className="accent-text-primary"
        />
      </label>
      <p className="mb-5 text-xs text-text-muted">{t('standIn.workspace.pause_help')}</p>
      <label className="grid gap-2">
        <span>{t('standIn.workspace.profile_instructions')}</span>
        <textarea
          data-testid="stand-in-preferences"
          value={draft.preferences}
          disabled={saving}
          onChange={event => setDraft({ ...draft, preferences: event.target.value })}
          placeholder={t('standIn.workspace.profile_instructions_placeholder')}
          rows={5}
          className="w-full resize-y rounded-lg border border-border bg-transparent p-3 text-sm"
        />
        <span className="text-xs text-text-muted">
          {t('standIn.workspace.profile_instructions_help')}
        </span>
      </label>
      <div className="mt-6 border-t border-border pt-5">
        <StandInConnectionSettings
          role={role}
          projects={projects}
          api={api}
          deviceId={settings.executionDeviceId}
          localDeviceId={localDeviceId}
          disabled={saving}
          onChange={value =>
            setDraft({ ...draft, collaboration: value.collaboration, dingtalk: value.dingtalk })
          }
        />
      </div>
      <section
        className="mt-6 space-y-3 border-t border-border pt-5"
        data-testid="stand-in-primary-execution"
      >
        <div>
          <h3 className="font-medium">{t('standIn.workspace.execution_settings')}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {t('standIn.workspace.execution_settings_help')}
          </p>
        </div>
        <StandInComposer
          draft={role}
          showPrompt={false}
          controls={null}
          onChange={update => {
            const next = typeof update === 'function' ? update(role) : update
            setDraft(current => ({
              ...current,
              model: next.model,
              modelOptions: next.modelOptions,
              workspace: next.workspace,
            }))
          }}
          onSave={async () => {}}
          disabled={saving}
          submitDisabled={saving}
          services={services}
          devices={devices}
          runtimeWork={runtimeWork}
          deviceControl={
            <StandInDeviceSelect
              value={settings.executionDeviceId}
              currentDeviceId={localDeviceId}
              devices={devices}
              disabled={saving || dirty}
              onChange={onSelectDevice}
            />
          }
        />
        <p className="text-xs text-text-muted">{t('standIn.workspace.execution_device_help')}</p>
        {runtimeError && (
          <div role="alert" className="text-sm text-error">
            <p>{runtimeError}</p>
            <button
              type="button"
              data-testid="stand-in-primary-environment-retry"
              className="min-h-8 underline"
              onClick={() => setReload(value => value + 1)}
            >
              {t('standIn.reload')}
            </button>
          </div>
        )}
      </section>
      {error && (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      )}
      {discard && (
        <div role="alert" className="mt-4 rounded-lg border border-border p-3">
          <p className="text-sm">{t('standIn.personal.discard_help')}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              data-testid="stand-in-primary-keep-editing"
              onClick={() => setDiscard(false)}
              className="min-h-8 text-sm underline"
            >
              {t('standIn.workspace.keep_editing')}
            </button>
            <button
              type="button"
              data-testid="stand-in-primary-discard"
              onClick={onClose}
              className="min-h-8 text-sm underline"
            >
              {t('standIn.workspace.discard')}
            </button>
          </div>
        </div>
      )}
      <footer className="sticky bottom-0 z-10 mt-6 flex justify-end gap-2 border-t border-border bg-background py-4">
        <button
          type="button"
          data-testid="stand-in-primary-cancel"
          disabled={saving}
          onClick={close}
          className="min-h-9 rounded-lg px-3 text-sm hover:bg-muted"
        >
          {t('standIn.cancel')}
        </button>
        <button
          type="button"
          data-testid="stand-in-primary-save"
          disabled={saving || !dirty}
          onClick={() => void onSave({ ...settings, primary: draft })}
          className="min-h-9 rounded-lg bg-text-primary px-4 text-sm text-background disabled:opacity-50"
        >
          {t('standIn.save')}
        </button>
      </footer>
    </div>
  )
}
