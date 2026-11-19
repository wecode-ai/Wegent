import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useRef, useState } from 'react'
import type { HookDraft, HookEventName, ResolvedHookPlugin } from './hooksTypes'

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
  const [eventName, setEventName] = useState<HookEventName>(first?.eventName ?? 'PostToolUse')
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
  const dialogRef = useRef<HTMLFormElement>(null)
  const valid =
    /^[a-z0-9-]+$/.test(id) && name.trim() && command.trim() && timeout >= 1 && timeout <= 300
  return (
    <DialogSurface
      onClose={onClose}
      render={
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-4" />
      }
    >
      <DialogSurface
        onClose={() => {
          if (!saving) onClose()
        }}
        render={
          <DialogForm
            ref={dialogRef}
            className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-auto rounded-2xl bg-background p-6 shadow-xl"
            onSubmit={async event => {
              event.preventDefault()
              if (!valid || saving) return
              setSaving(true)
              try {
                const edited = {
                  eventName,
                  matcher,
                  config: {
                    ...first?.config,
                    type: 'command' as const,
                    command,
                    ...(commandWindows ? { commandWindows } : {}),
                    timeout,
                    async: eventName !== 'PostToolUse' || asynchronous,
                    ...(statusMessage ? { statusMessage } : {}),
                  },
                }
                if (!commandWindows) delete edited.config.commandWindows
                if (!statusMessage) delete edited.config.statusMessage
                const hooks: HookDraft['hooks'] = {}
                for (const handler of [edited, ...(plugin?.handlers.slice(1) ?? [])]) {
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
          />
        }
      >
        <h2 className="heading-small">{plugin ? t('edit_title') : t('create_title')}</h2>
        <label className="block text-sm">
          <span className="mb-1 block text-text-secondary">{t('event')}</span>
          <SelectRoot
            value={normalizeSelectValue(eventName)}
            onValueChange={selectedValue => {
              if (selectedValue === null) return
              const next = selectedValue as HookEventName
              setEventName(next)
              setMatcher(next === 'PostToolUse' ? '^(apply_patch|Write|Edit)$' : '.*')
            }}
          >
            <SelectTrigger data-testid="hook-editor-event" className="h-9 w-full" />
            <SelectContent>
              {(['PostToolUse', 'TurnStarted', 'TurnCompleted', 'ExecutionCompleted'] as const).map(
                name => (
                  <SelectItem key={name} value={String(name)}>
                    {t('event_' + name)}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </SelectRoot>
        </label>
        {eventName !== 'PostToolUse' && (
          <p className="text-sm text-text-secondary">{t('lifecycle_help')}</p>
        )}
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
              {t(key === 'matcher' && eventName !== 'PostToolUse' ? 'status_matcher' : String(key))}
            </span>
            <ControlInput
              data-testid={`hook-editor-${String(key)}`}
              className="h-9 w-full"
              value={String(value)}
              disabled={Boolean(disabled)}
              onChange={event => (setter as (value: string) => void)(event.target.value)}
            />
          </label>
        ))}
        <label className="block text-sm">
          <span className="mb-1 block text-text-secondary">{t('timeout')}</span>
          <ControlInput
            data-testid="hook-editor-timeout"
            type="number"
            min={1}
            max={300}
            className="h-9 w-full"
            value={timeout}
            onChange={event => setTimeoutValue(Number(event.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            data-testid="hook-editor-async"
            checked={eventName !== 'PostToolUse' || asynchronous}
            disabled={eventName !== 'PostToolUse'}
            onCheckedChange={checked => setAsynchronous(checked === true)}
          />
          {t('async')}
        </label>
        <div className="flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            className="h-8 rounded-full px-3 hover:bg-muted"
            onClick={onClose}
          >
            {t('cancel')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="submit"
            data-testid="hook-editor-save"
            disabled={!valid || saving}
            className="h-8 rounded-full bg-text-primary px-4 text-background disabled:opacity-40"
          >
            {t('save')}
          </ControlButton>
        </div>
      </DialogSurface>
    </DialogSurface>
  )
}
