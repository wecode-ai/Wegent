import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { HookDraft, HookEventName, ResolvedHookPlugin } from './hooksTypes'

const DEFAULT_TOOL_MATCHER = '^(apply_patch|Write|Edit)$'

export function HookEditorDialog({
  plugin,
  onClose,
  onSave,
}: {
  plugin?: ResolvedHookPlugin
  onClose: () => void
  onSave: (draft: HookDraft) => Promise<void>
}) {
  const { t } = useTranslation('hooks')
  const first = plugin?.handlers[0]
  const [id, setId] = useState(plugin?.manifest.id ?? '')
  const [name, setName] = useState(plugin?.manifest.name ?? '')
  const [description, setDescription] = useState(plugin?.manifest.description ?? '')
  const [version, setVersion] = useState(plugin?.manifest.version ?? '1.0.0')
  const [eventName, setEventName] = useState<HookEventName>(first?.eventName ?? 'PostToolUse')
  const [matcher, setMatcher] = useState(first?.matcher ?? DEFAULT_TOOL_MATCHER)
  const [command, setCommand] = useState(first?.config.command ?? '')
  const [commandWindows, setCommandWindows] = useState(first?.config.commandWindows ?? '')
  const [timeout, setTimeoutValue] = useState(first?.config.timeout ?? 10)
  const [asynchronous, setAsynchronous] = useState(first?.config.async ?? false)
  const [statusMessage, setStatusMessage] = useState(first?.config.statusMessage ?? '')
  const [saving, setSaving] = useState(false)
  const dialogRef = useDialogKeyboard<HTMLFormElement>(() => {
    if (!saving) onClose()
  })
  const valid =
    /^[a-z0-9-]+$/.test(id) && name.trim() && command.trim() && timeout >= 1 && timeout <= 300
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
    >
      <DialogForm
        ref={dialogRef}
        className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-auto rounded-2xl bg-background p-6 shadow-xl"
        onSubmit={async event => {
          event.preventDefault()
          if (!valid || saving) return
          setSaving(true)
          try {
            const hooks: HookDraft['hooks'] = {}
            const handlers = [
              {
                eventName,
                matcher,
                config: {
                  type: 'command' as const,
                  command,
                  ...(commandWindows ? { commandWindows } : {}),
                  ...(first?.config.commands ? { commands: first.config.commands } : {}),
                  timeout,
                  async: asynchronous,
                  ...(statusMessage ? { statusMessage } : {}),
                },
              },
              ...(plugin?.handlers.slice(1) ?? []),
            ]
            for (const handler of handlers) {
              const groups = (hooks[handler.eventName] ??= [])
              groups.push({ matcher: handler.matcher, hooks: [handler.config] })
            }
            await onSave({
              manifest: {
                ...plugin?.manifest,
                schemaVersion: 1,
                id,
                name: name.trim(),
                description: description.trim(),
                version,
              },
              hooks,
            })
            onClose()
          } finally {
            setSaving(false)
          }
        }}
      >
        <h2 className="heading-small">{plugin ? t('edit_title') : t('create_title')}</h2>
        <label className="block text-sm">
          <span className="mb-1 block text-text-secondary">{t('event')}</span>
          <select
            data-testid="hook-editor-event"
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary"
            value={eventName}
            onChange={event => {
              const next = event.target.value as HookEventName
              setEventName(next)
              setMatcher(next === 'TurnCompleted' ? '.*' : DEFAULT_TOOL_MATCHER)
            }}
          >
            <option className="bg-background text-text-primary" value="PostToolUse">
              {t('event_post_tool_use')}
            </option>
            <option className="bg-background text-text-primary" value="TurnCompleted">
              {t('event_turn_completed')}
            </option>
          </select>
          {eventName === 'TurnCompleted' && (
            <span className="mt-1 block text-xs text-text-secondary">
              {t('event_turn_completed_help')}
            </span>
          )}
        </label>
        {[
          ['id', id, setId, plugin ? true : false],
          ['name', name, setName, false],
          ['description', description, setDescription, false],
          ['version', version, setVersion, false],
          ['matcher', matcher, setMatcher, false],
          ['command', command, setCommand, false],
          ['command_windows', commandWindows, setCommandWindows, false],
          ['status_message', statusMessage, setStatusMessage, false],
        ].map(([key, value, setter, disabled]) => (
          <label key={String(key)} className="block text-sm">
            <span className="mb-1 block text-text-secondary">
              {t(
                key === 'matcher' && eventName === 'TurnCompleted' ? 'status_matcher' : String(key)
              )}
            </span>
            <input
              data-testid={`hook-editor-${String(key)}`}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={String(value)}
              disabled={Boolean(disabled)}
              onChange={event => (setter as (value: string) => void)(event.target.value)}
            />
          </label>
        ))}
        <label className="block text-sm">
          <span className="mb-1 block text-text-secondary">{t('timeout')}</span>
          <input
            data-testid="hook-editor-timeout"
            type="number"
            min={1}
            max={300}
            className="h-9 w-full rounded-lg border border-border bg-background px-3"
            value={timeout}
            onChange={event => setTimeoutValue(Number(event.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            data-testid="hook-editor-async"
            type="checkbox"
            checked={asynchronous}
            onChange={event => setAsynchronous(event.target.checked)}
          />
          {t('async')}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="h-8 rounded-full px-3 hover:bg-muted" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            data-testid="hook-editor-save"
            disabled={!valid || saving}
            className="h-8 rounded-full bg-text-primary px-4 text-background disabled:opacity-40"
          >
            {t('save')}
          </button>
        </div>
      </DialogForm>
    </div>
  )
}
