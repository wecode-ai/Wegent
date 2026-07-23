import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { HookDraft, ResolvedHookPlugin } from './hooksTypes'

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
  const [matcher, setMatcher] = useState(first?.matcher ?? '^(apply_patch|Write|Edit)$')
  const [command, setCommand] = useState(first?.config.command ?? '')
  const [commandWindows, setCommandWindows] = useState(first?.config.commandWindows ?? '')
  const [timeout, setTimeoutValue] = useState(first?.config.timeout ?? 10)
  const [asynchronous, setAsynchronous] = useState(first?.config.async ?? false)
  const [statusMessage, setStatusMessage] = useState(first?.config.statusMessage ?? '')
  const [saving, setSaving] = useState(false)
  const valid =
    /^[a-z0-9-]+$/.test(id) && name.trim() && command.trim() && timeout >= 1 && timeout <= 300
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-auto rounded-2xl bg-background p-6 shadow-xl"
        onSubmit={async event => {
          event.preventDefault()
          if (!valid) return
          setSaving(true)
          try {
            await onSave({
              manifest: {
                schemaVersion: 1,
                id,
                name: name.trim(),
                description: description.trim(),
                version,
              },
              hooks: {
                PostToolUse: [
                  {
                    matcher,
                    hooks: [
                      {
                        type: 'command',
                        command,
                        ...(commandWindows ? { commandWindows } : {}),
                        ...(first?.config.commands ? { commands: first.config.commands } : {}),
                        timeout,
                        async: asynchronous,
                        ...(statusMessage ? { statusMessage } : {}),
                      },
                    ],
                  },
                ],
              },
            })
            onClose()
          } finally {
            setSaving(false)
          }
        }}
      >
        <h2 className="heading-small">{plugin ? t('edit_title') : t('create_title')}</h2>
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
            <span className="mb-1 block text-text-secondary">{t(String(key))}</span>
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
      </form>
    </div>
  )
}
