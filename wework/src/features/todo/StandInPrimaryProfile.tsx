import { useState } from 'react'
import { X } from 'lucide-react'
import { dequal } from 'dequal'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { CollaborationProject } from '@wegent/collaboration'
import { StandInConnections } from './StandInConnections'
import { StandInDingTalkConnections } from './StandInDingTalkConnections'
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
}: {
  settings: PersonalStandInSettings
  saving: boolean
  error: string | null
  onSave(settings: PersonalStandInSettings): Promise<void>
  onClose(): void
  api?: StandInExecutorApi
  localDeviceId: string
  projects: CollaborationProject[]
}) {
  const { t } = useTranslation('common')
  const original = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  const [draft, setDraft] = useState(original)
  const [discard, setDiscard] = useState(false)
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
      className="flex h-full flex-col p-5"
      data-testid="stand-in-primary-profile"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
    >
      <header className="mb-6 flex items-center gap-3">
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
      <label className="mb-5 grid gap-2">
        <span>{t('standIn.workspace.primary_responsibilities')}</span>
        <textarea
          data-testid="stand-in-primary-prompt"
          value={draft.prompt}
          disabled={saving}
          onChange={event => setDraft({ ...draft, prompt: event.target.value })}
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-transparent p-3 text-sm"
        />
      </label>
      <label className="grid gap-2">
        <span>{t('standIn.workspace.about_me')}</span>
        <textarea
          data-testid="stand-in-preferences"
          value={draft.preferences}
          disabled={saving}
          onChange={event => setDraft({ ...draft, preferences: event.target.value })}
          rows={6}
          className="w-full resize-y rounded-lg border border-border bg-transparent p-3 text-sm"
        />
        <span className="text-xs text-text-muted">{t('standIn.workspace.preferences_help')}</span>
      </label>
      <div className="mt-6 space-y-5">
        <StandInConnections
          role={role}
          projects={projects}
          disabled={saving}
          onChange={value => setDraft({ ...draft, collaboration: value.collaboration })}
        />
        {api && (
          <StandInDingTalkConnections
            role={role}
            api={api}
            deviceId={settings.executionDeviceId}
            localDeviceId={localDeviceId}
            disabled={saving}
            onChange={value => setDraft({ ...draft, dingtalk: value.dingtalk })}
          />
        )}
      </div>
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
      <footer className="mt-auto flex justify-end gap-2 pt-6">
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
