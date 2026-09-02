import { Check, Copy, RefreshCw, Webhook, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProjectEventCollectionMode,
  ProjectEventSourceType,
  ProjectIncomingEvent,
  ProjectIncomingHook,
} from '@/api/projectIncomingHooks'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { automationClass } from './automationStyles'
import { eventTypeLabel } from './eventTypeLabel'

type IncomingHookApi = ReturnType<typeof createProjectIncomingHookApi>

interface SubscriptionDraft {
  name: string
  resourceUrl: string
  pollIntervalSeconds: number
  credentialRef: string
}

function emptyDraft(): SubscriptionDraft {
  return {
    name: '',
    resourceUrl: '',
    pollIntervalSeconds: 300,
    credentialRef: '',
  }
}

function subscriptionResourceLabel(subscription: ProjectIncomingHook): string {
  return (
    subscription.resource.displayName ||
    subscription.resource.path ||
    subscription.resource.url ||
    subscription.resource.externalId ||
    subscription.name
  )
}

export function EventSubscriptionManager({
  api,
  projectId,
  sourceType,
  collectionMode,
  sourceLabel,
  cascadeIndex = 2,
  value,
  onChange,
}: {
  api?: IncomingHookApi
  projectId?: string
  sourceType: ProjectEventSourceType
  collectionMode: ProjectEventCollectionMode
  sourceLabel: (sourceType: ProjectEventSourceType) => string
  cascadeIndex?: number
  value: string | null
  onChange: (subscriptionId: string | null) => void
}) {
  const { t } = useTranslation('common')
  const [subscriptions, setSubscriptions] = useState<ProjectIncomingHook[]>([])
  const [draft, setDraft] = useState<SubscriptionDraft>(emptyDraft)
  const [editorOpen, setEditorOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedValue, setCopiedValue] = useState<string | null>(null)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})
  const [eventsBySubscription, setEventsBySubscription] = useState<
    Record<string, ProjectIncomingEvent[]>
  >({})
  const [expandedSubscriptionId, setExpandedSubscriptionId] = useState<string | null>(null)
  const selectionLockRef = useRef(false)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)

  const selectedSubscription = subscriptions.find(item => item.id === value) ?? null

  const load = useCallback(async () => {
    if (!api || !projectId) return
    try {
      const list = await api.list(projectId)
      const scoped = list.filter(
        item => item.sourceType === sourceType && item.collectionMode === collectionMode
      )
      setSubscriptions(scoped)
      const current = valueRef.current
      const selected = scoped.find(item => item.id === current)
      if (!selected && scoped.length > 0 && !selectionLockRef.current) {
        selectionLockRef.current = true
        onChangeRef.current(scoped[0].id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_load_failed'))
    }
  }, [api, projectId, sourceType, collectionMode, t])

  useEffect(() => {
    valueRef.current = value
    onChangeRef.current = onChange
  })

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  async function createSubscription() {
    const needsCredential = collectionMode === 'poll' || collectionMode === 'hybrid'
    if (
      !api ||
      !projectId ||
      busy ||
      !draft.resourceUrl.trim() ||
      (needsCredential && !draft.credentialRef.trim())
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const subscription = await api.create(projectId, {
        name: draft.name.trim() || `${sourceLabel(sourceType)} subscription`,
        sourceType,
        collectionMode,
        resource: {
          url: draft.resourceUrl.trim(),
        },
        pollIntervalSeconds:
          collectionMode === 'poll' || collectionMode === 'hybrid'
            ? draft.pollIntervalSeconds
            : null,
        credentialRef: draft.credentialRef.trim() || null,
      })
      selectionLockRef.current = true
      if (subscription.webhookSecret) {
        setRevealedSecrets(current => ({
          ...current,
          [subscription.id]: subscription.webhookSecret!,
        }))
      }
      await load()
      onChangeRef.current(subscription.id)
      setEditorOpen(false)
      setDraft(emptyDraft())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_create_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function toggleSubscription(subscription: ProjectIncomingHook) {
    if (!api || !projectId || busy) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api.update(projectId, subscription.id, {
        version: subscription.version,
        status: subscription.status === 'active' ? 'disabled' : 'active',
      })
      setSubscriptions(current => current.map(item => (item.id === updated.id ? updated : item)))
      if (updated.webhookSecret) {
        setRevealedSecrets(current => ({
          ...current,
          [updated.id]: updated.webhookSecret!,
        }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_update_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function rotateSubscription(subscription: ProjectIncomingHook) {
    if (
      !api ||
      !projectId ||
      busy ||
      !window.confirm(t('todo.event_subscription_rotate_confirm'))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await api.rotate(projectId, subscription.id)
      setSubscriptions(current => current.map(item => (item.id === updated.id ? updated : item)))
      if (updated.webhookSecret) {
        setRevealedSecrets(current => ({
          ...current,
          [updated.id]: updated.webhookSecret!,
        }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_rotate_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function copyValue(selectedValue: string) {
    try {
      await navigator.clipboard.writeText(selectedValue)
      setCopiedValue(selectedValue)
      window.setTimeout(
        () => setCopiedValue(current => (current === selectedValue ? null : current)),
        1500
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_copy_failed'))
    }
  }

  async function toggleEvents(subscription: ProjectIncomingHook) {
    if (!api || !projectId) return
    if (expandedSubscriptionId === subscription.id) {
      setExpandedSubscriptionId(null)
      return
    }
    setExpandedSubscriptionId(subscription.id)
    if (eventsBySubscription[subscription.id]) return
    try {
      const events = await api.listEvents(projectId, subscription.id)
      setEventsBySubscription(current => ({ ...current, [subscription.id]: events }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_events_failed'))
    }
  }

  if (!api || !projectId) {
    return (
      <p className={automationClass('panel-help')}>
        {t('todo.automation_event_subscription_missing')}
      </p>
    )
  }

  return (
    <div className="grid gap-2">
      <label className={automationClass('panel-field')}>
        <span>
          <i className={automationClass('cascade-index')}>{cascadeIndex}</i>
          {t('todo.automation_event_subscription')}
        </span>
        <div className="flex items-center gap-2">
          <select
            data-testid="automation-event-subscription"
            value={value ?? ''}
            disabled={busy || subscriptions.length === 0}
            onChange={event => onChange(event.target.value)}
            className="flex-1"
          >
            {subscriptions.length === 0 ? (
              <option value="">{t('todo.automation_event_subscription_none')}</option>
            ) : (
              subscriptions.map(subscription => (
                <option key={subscription.id} value={subscription.id}>
                  {subscription.name}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            data-testid="automation-create-subscription"
            disabled={busy}
            onClick={() => setEditorOpen(current => !current)}
            className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary shadow-sm hover:text-text-primary"
          >
            ＋ {t('todo.event_subscription_add')}
          </button>
        </div>
      </label>

      {editorOpen ? (
        <div
          className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3"
          data-testid="event-subscription-editor"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-text-secondary">
              <span className="mb-1 block">{t('todo.event_subscription_name')}</span>
              <input
                data-testid="event-subscription-name"
                value={draft.name}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                className="h-9 w-full rounded-lg border border-border bg-background px-3"
              />
            </label>
            <label className="text-sm text-text-secondary">
              <span className="mb-1 block">{t('todo.event_subscription_resource_url')}</span>
              <input
                data-testid="event-subscription-resource-url"
                value={draft.resourceUrl}
                onChange={event =>
                  setDraft(current => ({ ...current, resourceUrl: event.target.value }))
                }
                placeholder={
                  sourceType === 'gitlab'
                    ? 'https://gitlab.com/group/project'
                    : 'https://github.com/owner/repository'
                }
                className="h-9 w-full rounded-lg border border-border bg-background px-3"
              />
            </label>
            {collectionMode === 'poll' || collectionMode === 'hybrid' ? (
              <>
                <label className="text-sm text-text-secondary">
                  <span className="mb-1 block">{t('todo.event_subscription_interval')}</span>
                  <input
                    data-testid="event-subscription-poll-interval"
                    type="number"
                    min={60}
                    max={86400}
                    value={draft.pollIntervalSeconds}
                    onChange={event =>
                      setDraft(current => ({
                        ...current,
                        pollIntervalSeconds: Number(event.target.value),
                      }))
                    }
                    className="h-9 w-full rounded-lg border border-border bg-background px-3"
                  />
                </label>
                <label className="text-sm text-text-secondary">
                  <span className="mb-1 block">{t('todo.event_subscription_credential')}</span>
                  <input
                    data-testid="event-subscription-credential"
                    value={draft.credentialRef}
                    onChange={event =>
                      setDraft(current => ({ ...current, credentialRef: event.target.value }))
                    }
                    placeholder={t('todo.event_subscription_credential_placeholder')}
                    className="h-9 w-full rounded-lg border border-border bg-background px-3"
                  />
                  <span className="mt-1 block text-xs text-text-muted">
                    {t('todo.event_subscription_credential_hint')}
                  </span>
                </label>
              </>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="event-subscription-cancel"
              onClick={() => setEditorOpen(false)}
              className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-background"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="event-subscription-save"
              disabled={
                busy ||
                !draft.resourceUrl.trim() ||
                ((collectionMode === 'poll' || collectionMode === 'hybrid') &&
                  !draft.credentialRef.trim())
              }
              onClick={() => void createSubscription()}
              className="h-8 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-40"
            >
              {t('todo.event_subscription_save')}
            </button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}

      {selectedSubscription ? (
        <div className={automationClass('subscription-resource')}>
          <div className={automationClass('subscription-resource-title')}>
            <div>
              <strong>{t('todo.automation_event_subscription_resource')}</strong>
              <span>{sourceLabel(selectedSubscription.sourceType)}</span>
            </div>
            <small>{selectedSubscription.status}</small>
          </div>
          <div>
            <span>{t('todo.automation_event_subscription_source')}</span>
            <strong>{subscriptionResourceLabel(selectedSubscription)}</strong>
            {selectedSubscription.resource.url ? (
              <a
                href={selectedSubscription.resource.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-xs text-focus hover:underline"
              >
                {selectedSubscription.resource.url}
              </a>
            ) : null}
          </div>
          {selectedSubscription.webhookUrl ? (
            <div className={automationClass('subscription-resource-url')}>
              <span>{t('todo.automation_event_subscription_webhook_url')}</span>
              <code>{selectedSubscription.webhookUrl}</code>
              <button
                type="button"
                data-testid="automation-copy-webhook-url"
                className={automationClass('subscription-resource-copy')}
                onClick={() => void copyValue(selectedSubscription.webhookUrl!)}
              >
                {copiedValue === selectedSubscription.webhookUrl ? (
                  <Check size={12} />
                ) : (
                  <Copy size={12} />
                )}
                {copiedValue === selectedSubscription.webhookUrl
                  ? t('common.copied')
                  : t('todo.automation_event_subscription_copy_url')}
              </button>
            </div>
          ) : null}
          {revealedSecrets[selectedSubscription.id] ? (
            <div
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
              data-testid={`event-subscription-secret-${selectedSubscription.id}`}
            >
              <span className="min-w-0 flex-1 truncate text-code">
                {revealedSecrets[selectedSubscription.id]}
              </span>
              <button
                type="button"
                onClick={() => void copyValue(revealedSecrets[selectedSubscription.id])}
                className="shrink-0 text-xs text-text-secondary"
              >
                {t('todo.event_subscription_copy_secret')}
              </button>
              <button
                type="button"
                onClick={() =>
                  setRevealedSecrets(current => {
                    const next = { ...current }
                    delete next[selectedSubscription.id]
                    return next
                  })
                }
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                aria-label={t('todo.event_subscription_hide_secret')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          <div className="flex items-center gap-1">
            {selectedSubscription.webhookUrl ? (
              <Tooltip label={t('todo.event_subscription_rotate')}>
                <button
                  type="button"
                  data-testid={`event-subscription-rotate-${selectedSubscription.id}`}
                  disabled={busy}
                  onClick={() => void rotateSubscription(selectedSubscription)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-background hover:text-text-primary disabled:opacity-40"
                  aria-label={t('todo.event_subscription_rotate')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            ) : null}
            <button
              type="button"
              data-testid={`event-subscription-toggle-${selectedSubscription.id}`}
              disabled={busy}
              onClick={() => void toggleSubscription(selectedSubscription)}
              className="h-7 rounded-md px-2 text-xs text-text-secondary hover:bg-background disabled:opacity-40"
            >
              {selectedSubscription.status === 'active'
                ? t('todo.event_subscription_disable')
                : t('todo.event_subscription_enable')}
            </button>
            <button
              type="button"
              data-testid={`event-subscription-events-${selectedSubscription.id}`}
              onClick={() => void toggleEvents(selectedSubscription)}
              className="ml-auto h-7 rounded-md px-2 text-xs text-text-secondary hover:bg-background"
            >
              {expandedSubscriptionId === selectedSubscription.id
                ? t('todo.event_subscription_hide_events')
                : t('todo.event_subscription_show_events')}
            </button>
          </div>
          {selectedSubscription.health?.lastError ? (
            <p className="text-xs text-destructive">{selectedSubscription.health.lastError}</p>
          ) : null}
          {expandedSubscriptionId === selectedSubscription.id ? (
            <div className="space-y-1" aria-live="polite">
              {eventsBySubscription[selectedSubscription.id] ? (
                eventsBySubscription[selectedSubscription.id].length ? (
                  eventsBySubscription[selectedSubscription.id].map(event => (
                    <div
                      key={event.id}
                      className="flex items-start justify-between gap-3 rounded-lg bg-background px-3 py-2 text-xs"
                    >
                      <span>
                        {event.normalizedEvents
                          .map(item => item.eventType && eventTypeLabel(item.eventType, t))
                          .filter(Boolean)
                          .join(', ') || event.sourceType}
                      </span>
                      <span
                        className={cn(
                          'shrink-0',
                          event.status === 'failed' ? 'text-destructive' : 'text-text-muted'
                        )}
                      >
                        {event.status}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-text-muted">
                    {t('todo.event_subscription_no_events')}
                  </p>
                )
              ) : (
                <p className="text-xs text-text-muted">
                  {t('todo.event_subscription_loading_events')}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : subscriptions.length === 0 ? (
        <p className={automationClass('panel-help')}>
          <Webhook size={14} />
          <p>{t('todo.automation_event_subscription_missing')}</p>
        </p>
      ) : null}
    </div>
  )
}
