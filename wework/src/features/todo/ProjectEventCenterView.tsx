import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BoardIncomingEvent,
  EventCenterConfig,
  createProjectEventCenterApi,
} from '@/api/projectEventCenter'
import type { RuntimeProfile, createRuntimeProfileApi } from '@/api/runtimeProfiles'
import { runtimeProfileIsRunnable } from '@/api/runtimeProfiles'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface Props {
  api: ReturnType<typeof createProjectEventCenterApi>
  runtimeProfileApi: ReturnType<typeof createRuntimeProfileApi>
  projectId: string
  canManage: boolean
  canSubmit: boolean
  onOpenIssue: (issueId: string) => Promise<void>
  onOpenHooks: () => void
}

export function ProjectEventCenterView({
  api,
  runtimeProfileApi,
  projectId,
  canManage,
  canSubmit,
  onOpenIssue,
  onOpenHooks,
}: Props) {
  const { t } = useTranslation('common')
  const requestSequence = useRef(0)
  const [events, setEvents] = useState<BoardIncomingEvent[]>([])
  const [config, setConfig] = useState<EventCenterConfig | null>(null)
  const [profiles, setProfiles] = useState<RuntimeProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = events.find(event => event.id === selectedId) ?? events[0]
  const control =
    'min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base text-text-primary md:min-h-9'
  const statusLabel = (value: string) => t(`todo.event_center_status_${value}`, value)

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    const values = await api.list(projectId)
    if (sequence === requestSequence.current) setEvents(values)
  }, [api, projectId])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const sequence = ++requestSequence.current
        const values = await api.list(projectId)
        if (active && sequence === requestSequence.current) setEvents(values)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : t('todo.event_center_failed'))
      } finally {
        if (active) timer = setTimeout(() => void poll(), 3000)
      }
    }
    void poll()
    void Promise.all([
      api.config(projectId),
      canManage ? runtimeProfileApi.list() : Promise.resolve([]),
    ])
      .then(([values, catalog]) => {
        if (!active) return
        setConfig(values)
        setSettingsOpen(!values.enabled && canManage)
        setProfiles(catalog.filter(runtimeProfileIsRunnable))
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : t('todo.event_center_failed'))
      })
    return () => {
      active = false
      requestSequence.current += 1
      clearTimeout(timer)
    }
  }, [api, projectId, runtimeProfileApi, canManage, t])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_center_failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-5"
      data-testid="project-event-center"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="heading-sm">{t('todo.event_center_title')}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t('todo.event_center_description')}</p>
        </div>
        {canManage ? (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="min-h-11 md:min-h-9"
              data-testid="event-center-hooks"
              onClick={onOpenHooks}
            >
              {t('todo.event_center_hooks')}
            </Button>
            <Button
              variant="secondary"
              className="min-h-11 md:min-h-9"
              data-testid="event-center-settings"
              onClick={() => setSettingsOpen(value => !value)}
            >
              {t('todo.event_center_settings')}
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {settingsOpen && config && canManage ? (
        <form
          className="mb-5 grid max-w-2xl gap-3 rounded-xl bg-muted/40 p-4"
          onSubmit={event => {
            event.preventDefault()
            void run(async () => {
              setConfig(await api.configure(projectId, config))
              setSettingsOpen(false)
              await refresh()
            })
          }}
        >
          <label className="flex min-h-11 items-center gap-2 text-base">
            <input
              type="checkbox"
              data-testid="event-center-enabled"
              checked={config.enabled}
              onChange={event => setConfig({ ...config, enabled: event.target.checked })}
            />
            {t('todo.event_center_enabled')}
          </label>
          <label className="grid gap-1 text-sm">
            {t('todo.event_center_runtime')}
            <select
              className={control}
              data-testid="event-center-runtime"
              value={config.runtime_profile_id ?? ''}
              onChange={event =>
                setConfig({ ...config, runtime_profile_id: event.target.value || null })
              }
            >
              <option value="">{t('todo.event_center_select_runtime')}</option>
              {profiles.map(profile => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.model}
                </option>
              ))}
            </select>
          </label>
          {!profiles.length ? (
            <p className="text-sm text-text-secondary">{t('todo.event_center_no_runtime')}</p>
          ) : null}
          <label className="grid gap-1 text-sm">
            {t('todo.event_center_instruction')}
            <textarea
              className={control}
              data-testid="event-center-instruction"
              rows={3}
              maxLength={4000}
              value={config.instruction}
              onChange={event => setConfig({ ...config, instruction: event.target.value })}
            />
          </label>
          <p className="text-sm text-text-secondary">{t('todo.event_center_generated_runtime')}</p>
          <Button
            type="submit"
            className="min-h-11 justify-self-start md:min-h-9"
            data-testid="event-center-save"
            disabled={busy || (config.enabled && !config.runtime_profile_id)}
          >
            {t('todo.event_center_save')}
          </Button>
        </form>
      ) : null}
      {canSubmit ? (
        <form
          className="mb-5 flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault()
            if (!newContent.trim()) return
            void run(async () => {
              const created = await api.submit(projectId, {
                title: newContent.trim().split('\n')[0]!.slice(0, 255),
                content: newContent.trim(),
                request_id: requestId,
              })
              setSelectedId(created.id)
              setNewContent('')
              setRequestId(crypto.randomUUID())
              await refresh()
            })
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-sm">
            {t('todo.event_center_new_task')}
            <textarea
              className={control}
              data-testid="event-center-submit-content"
              rows={2}
              maxLength={65536}
              value={newContent}
              onChange={event => setNewContent(event.target.value)}
              placeholder={t('todo.event_center_task_placeholder')}
            />
          </label>
          <Button
            type="submit"
            className="min-h-11 md:min-h-9"
            data-testid="event-center-submit"
            disabled={busy || !newContent.trim()}
          >
            {t('todo.event_center_submit')}
          </Button>
        </form>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
        <div className="grid gap-1" aria-label={t('todo.event_center_event_list')}>
          {!events.length ? (
            <p className="py-5 text-sm text-text-secondary">{t('todo.event_center_empty')}</p>
          ) : (
            events.map(event => (
              <button
                key={event.id}
                type="button"
                data-testid={`event-center-event-${event.id}`}
                aria-pressed={selected?.id === event.id}
                onClick={() => setSelectedId(event.id)}
                className={cn(
                  'grid min-h-11 gap-1 rounded-lg p-3 text-left text-base hover:bg-muted',
                  selected?.id === event.id && 'bg-muted'
                )}
              >
                <span className="break-words">{event.title}</span>
                <span className="text-xs text-text-secondary">
                  {event.provider} · {statusLabel(event.status)}
                </span>
              </button>
            ))
          )}
        </div>
        {selected ? (
          <section className="min-w-0" data-testid="event-center-detail">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="heading-sm break-words">{selected.title}</h3>
              <span className="text-sm text-text-secondary" role="status">
                {statusLabel(selected.status)}
              </span>
            </div>
            <div className="my-4 grid gap-4">
              {selected.history.map((entry, index) => (
                <div key={`${entry.at}-${index}`}>
                  <p className="mb-1 text-xs text-text-secondary">
                    {t(`todo.event_center_role_${entry.role}`, entry.role)}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-base">{entry.content}</p>
                </div>
              ))}
            </div>
            {selected.error ? (
              <p role="alert" className="mb-3 text-sm text-red-600">
                {selected.error}
              </p>
            ) : null}
            {selected.status === 'clarifying' && canSubmit ? (
              <form
                className="grid gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  void run(async () => {
                    await api.reply(projectId, selected, replies[selected.id] ?? '')
                    setReplies(values => ({ ...values, [selected.id]: '' }))
                    await refresh()
                  })
                }}
              >
                <label className="grid gap-1 text-sm">
                  {selected.question}
                  <textarea
                    className={control}
                    data-testid="event-center-reply-content"
                    rows={3}
                    value={replies[selected.id] ?? ''}
                    maxLength={16000}
                    onChange={event =>
                      setReplies(values => ({ ...values, [selected.id]: event.target.value }))
                    }
                  />
                </label>
                <Button
                  type="submit"
                  className="min-h-11 justify-self-start md:min-h-9"
                  data-testid="event-center-reply"
                  disabled={busy || !replies[selected.id]?.trim()}
                >
                  {t('todo.event_center_reply')}
                </Button>
              </form>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {selected.issue_id ? (
                <Button
                  variant="secondary"
                  className="min-h-11 md:min-h-9"
                  data-testid="event-center-open-issue"
                  onClick={() => void run(() => onOpenIssue(selected.issue_id!))}
                >
                  {t('todo.event_center_open_issue')} · {selected.issue_id}
                </Button>
              ) : null}
              {canSubmit &&
              ['failed', 'handoff_failed', 'waiting_configuration'].includes(selected.status) ? (
                <Button
                  variant="outline"
                  className="min-h-11 md:min-h-9"
                  data-testid="event-center-retry"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.retry(projectId, selected.id)
                      await refresh()
                    })
                  }
                >
                  {t('todo.event_center_retry')}
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
