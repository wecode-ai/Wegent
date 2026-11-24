import { type FormEvent, useState } from 'react'
import { useDialogKeyboard } from '@wegent/collaboration/dom-events'
import { X } from 'lucide-react'
import type {
  MessageCenterCommand,
  MessageCenterSettings as DelegationSettings,
  MessageCenterSnapshot,
} from '@/api/standInMessageCenter'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

const templates = ['document', 'confirmedLogistics', 'standardProcess'] as const

function sameScope(left: DelegationSettings, right: DelegationSettings) {
  return (
    left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every(id => right.sourceIds.includes(id)) &&
    templates.every(template => left.templates[template] === right.templates[template])
  )
}

export function MessageCenterSettings({
  snapshot,
  sourceId,
  busy,
  actionError,
  onClose,
  onOpenSettings,
  onCommand,
}: {
  snapshot: MessageCenterSnapshot | null
  sourceId: string | null
  busy: boolean
  actionError: boolean
  onClose(): void
  onOpenSettings(): void
  onCommand(command: MessageCenterCommand): Promise<boolean>
}) {
  const { t } = useTranslation('standInMessageCenter')
  const [edit, setEdit] = useState<{
    original: DelegationSettings
    draft: DelegationSettings
  } | null>(null)
  const canSave = snapshot?.capabilities.includes('saveSettings') ?? false
  const current = snapshot?.settings
  const draft = edit?.draft ?? current
  const scopeChanged = Boolean(
    current &&
    edit &&
    current.version !== edit.original.version &&
    !sameScope(current, edit.original)
  )
  const dirty = Boolean(current && draft && !sameScope(current, draft))
  const paused = snapshot?.status === 'paused'
  const canPause =
    (paused || snapshot?.status === 'active') && snapshot?.capabilities.includes('setPaused')
  const canPauseSource = snapshot?.capabilities.includes('setSourcePaused')
  const canEdit = canSave && !scopeChanged
  const canEnable = snapshot?.status === 'disabled' && snapshot.capabilities.includes('enable')
  const close = () => {
    if (!busy) onClose()
  }
  const initialFocus = sourceId
    ? '[data-message-center-focused-source]'
    : '[data-testid="message-center-settings-close"]'
  const dialogRef = useDialogKeyboard<HTMLElement>(close, true, initialFocus)

  const updateDraft = (next: DelegationSettings) => {
    if (!current) return
    setEdit({ draft: next, original: edit?.original ?? current })
  }

  const toggleSource = (settings: DelegationSettings, id: string, selected: boolean) => {
    updateDraft({
      ...settings,
      sourceIds: selected
        ? [...settings.sourceIds, id]
        : settings.sourceIds.filter(value => value !== id),
    })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!current || !draft || busy || !dirty || !canEdit) return
    const settings = { ...current, sourceIds: draft.sourceIds, templates: draft.templates }
    if (await onCommand({ type: 'saveSettings', settings })) onClose()
  }

  return (
    <div className="absolute inset-0 z-10 flex justify-end bg-black/20">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings')}
        tabIndex={-1}
        data-testid="message-center-settings"
        className="flex h-full w-full min-w-0 flex-col border-border bg-background shadow-lg md:max-w-xl md:border-l"
      >
        <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2 md:px-5">
            <h2 className="heading-sm flex-1">{t('settings')}</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 md:size-8"
              aria-label={t('close')}
              data-testid="message-center-settings-close"
              disabled={busy}
              onClick={close}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 md:p-5">
            {paused && <p className="text-sm text-text-secondary">{t('pausedHint')}</p>}
            {canPause && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-9"
                data-testid="message-center-settings-pause"
                disabled={busy}
                onClick={() => void onCommand({ type: 'setPaused', paused: !paused })}
              >
                {t(paused ? 'resume' : 'pause')}
              </Button>
            )}
            {snapshot && draft && current && (
              <>
                <fieldset disabled={busy}>
                  <legend className="mb-2 font-medium">{t('sourceSettingsTitle')}</legend>
                  {snapshot.sources.length === 0 && (
                    <p className="text-sm text-text-secondary">{t('noSources')}</p>
                  )}
                  {snapshot.sources.map(source => (
                    <div
                      key={source.id}
                      className={`flex min-h-11 flex-wrap items-center justify-between gap-x-2 border-b border-border px-2 ${sourceId === source.id ? 'rounded-md bg-muted' : ''}`}
                    >
                      <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          className="size-4 shrink-0 accent-text-primary focus-visible:outline-focus"
                          checked={draft.sourceIds.includes(source.id)}
                          data-message-center-focused-source={
                            sourceId === source.id && canEdit ? true : undefined
                          }
                          data-testid={`message-center-source-${source.id}`}
                          onChange={event => toggleSource(draft, source.id, event.target.checked)}
                        />
                        <span className="min-w-0 break-words">
                          <span className="block">{source.name}</span>
                          <span className="block text-xs text-text-secondary">
                            {t(source.kind === 'group' ? 'groupMentions' : 'directMessages')}
                            {source.paused && ` · ${t('sourcePaused')}`}
                          </span>
                        </span>
                      </label>
                      {source.included && canPauseSource && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11 md:min-h-9"
                          data-message-center-focused-source={
                            sourceId === source.id && !canEdit ? true : undefined
                          }
                          data-testid={`message-center-settings-pause-source-${source.id}`}
                          onClick={() =>
                            void onCommand({
                              type: 'setSourcePaused',
                              sourceId: source.id,
                              paused: !source.paused,
                            })
                          }
                        >
                          {t(source.paused ? 'resumeSource' : 'pauseSource')}
                        </Button>
                      )}
                    </div>
                  ))}
                </fieldset>
                <fieldset disabled={busy || !canEdit}>
                  <legend className="mb-2 font-medium">{t('templateSettingsTitle')}</legend>
                  {templates.map(template => (
                    <label
                      key={template}
                      className="flex min-h-11 items-center gap-3 border-b border-border px-2 py-2"
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-text-primary focus-visible:outline-focus"
                        checked={draft.templates[template]}
                        data-testid={`message-center-template-${template}`}
                        onChange={event =>
                          updateDraft({
                            ...draft,
                            templates: { ...draft.templates, [template]: event.target.checked },
                          })
                        }
                      />
                      <span className="min-w-0 break-words">{t(`template.${template}`)}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            <section className="space-y-2 break-words">
              {snapshot?.identity && (
                <p className="text-sm">
                  {t('account')} ·{' '}
                  {[snapshot.identity.account, snapshot.identity.organization]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {current?.modelName && (
                <p className="text-sm">
                  {t('model')} · {current.modelName}
                </p>
              )}
              {snapshot?.deviceName && (
                <>
                  <p className="text-sm">
                    {t('device')} · {snapshot.deviceName}
                  </p>
                  <p className="text-sm text-text-secondary">{t('localExecution')}</p>
                </>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-9"
                data-testid="message-center-manage-connection"
                onClick={onOpenSettings}
                disabled={busy}
              >
                {t(snapshot?.status === 'disconnected' ? 'connectionRequired' : 'manageConnection')}
              </Button>
            </section>
            {(actionError || scopeChanged) && (
              <div role="alert" className="space-y-2 text-sm text-error">
                <p>{t(scopeChanged ? 'settingsChanged' : 'actionError')}</p>
                {scopeChanged && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 md:min-h-9"
                    data-testid="message-center-settings-reload"
                    onClick={() => setEdit(null)}
                  >
                    {t('refresh')}
                  </Button>
                )}
              </div>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-border p-4 md:px-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="message-center-settings-cancel"
              onClick={close}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            {canSave && (
              <Button
                type="submit"
                size="sm"
                className="min-h-11 md:min-h-9"
                data-testid="message-center-settings-save"
                disabled={busy || !dirty || !canEdit}
              >
                {t('save')}
              </Button>
            )}
            {canEnable && (
              <Button
                type="button"
                size="sm"
                className="min-h-11 md:min-h-9"
                data-testid="message-center-settings-enable"
                disabled={busy || dirty || !current?.sourceIds.length}
                onClick={async () => {
                  if (await onCommand({ type: 'enable' })) onClose()
                }}
              >
                {t('enable')}
              </Button>
            )}
          </footer>
        </form>
      </section>
    </div>
  )
}
