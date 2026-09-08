import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  History,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProjectEventCollectionMode,
  ProjectEventSourceCatalogItem,
  ProjectEventSourceType,
  ProjectIncomingEvent,
  ProjectIncomingHook,
  createProjectIncomingHookApi,
} from '@/api/projectIncomingHooks'
import { PopupMenu } from '@/components/common/MenuSelect'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { automationClass } from './automationStyles'
import { eventTypeLabel } from './eventTypeLabel'

type IncomingHookApi = ReturnType<typeof createProjectIncomingHookApi>

interface SubscriptionDraft {
  name: string
  sourceType: ProjectEventSourceType
  collectionMode: ProjectEventCollectionMode
  resourceUrl: string
  pollIntervalSeconds: number
  credentialRef: string
}

function emptyDraft(catalog: ProjectEventSourceCatalogItem[]): SubscriptionDraft {
  const source = catalog.find(item => item.sourceType !== 'wework') ?? catalog[0]
  return {
    name: '',
    sourceType: source?.sourceType ?? 'github',
    collectionMode:
      source?.collectionModes.find(mode => mode === 'webhook') ??
      source?.collectionModes[0] ??
      'webhook',
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

function sourceName(sourceType: ProjectEventSourceType): string {
  if (sourceType === 'github') return 'GitHub'
  if (sourceType === 'gitlab') return 'GitLab'
  if (sourceType === 'wework') return 'Wework'
  return 'Generic'
}

export function EventSubscriptionPicker({
  api,
  projectId,
  sourceTypes,
  collectionMode,
  cascadeIndex,
  testIdPrefix = 'automation',
  value,
  onChange,
}: {
  api?: IncomingHookApi
  projectId?: string
  sourceTypes?: ProjectEventSourceType[]
  collectionMode: ProjectEventCollectionMode
  cascadeIndex: number
  testIdPrefix?: string
  value: string | null
  onChange: (subscriptionId: string | null) => void
}) {
  const { t } = useTranslation('common')
  const [subscriptions, setSubscriptions] = useState<ProjectIncomingHook[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  const loadSequenceRef = useRef(0)
  const sourceKey = [...(sourceTypes ?? [])].sort().join(',')
  const testId =
    testIdPrefix === 'automation'
      ? 'automation-event-subscription'
      : `${testIdPrefix}-event-subscription`

  useEffect(() => {
    onChangeRef.current = onChange
    valueRef.current = value
  })

  const load = useCallback(async () => {
    if (!api || !projectId) return
    const sequence = ++loadSequenceRef.current
    setLoading(true)
    setError(null)
    try {
      const allowedSources = new Set(sourceKey ? sourceKey.split(',') : [])
      const list = (await api.list(projectId)).filter(
        item =>
          item.collectionMode === collectionMode &&
          item.status === 'active' &&
          (!allowedSources.size || allowedSources.has(item.sourceType))
      )
      if (sequence !== loadSequenceRef.current) return
      setSubscriptions(list)
      if (!list.some(item => item.id === valueRef.current)) {
        const next = list[0]?.id ?? null
        if (next !== valueRef.current) onChangeRef.current(next)
      }
    } catch (cause) {
      if (sequence !== loadSequenceRef.current) return
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_load_failed'))
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false)
    }
  }, [api, collectionMode, projectId, sourceKey, t])

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
    return () => {
      loadSequenceRef.current += 1
    }
  }, [load])

  const selected = subscriptions.find(item => item.id === value) ?? null

  return (
    <div className="grid gap-2">
      <label className={automationClass('panel-field')}>
        <span>
          <i className={automationClass('cascade-index')}>{cascadeIndex}</i>
          {t('todo.automation_event_subscription')}
        </span>
        <select
          data-testid={testId}
          value={value ?? ''}
          disabled={loading || subscriptions.length === 0}
          onChange={event => onChange(event.target.value || null)}
        >
          {subscriptions.length === 0 ? (
            <option value="">{t('todo.automation_event_subscription_none')}</option>
          ) : (
            subscriptions.map(subscription => (
              <option key={subscription.id} value={subscription.id}>
                {subscription.name} · {subscriptionResourceLabel(subscription)}
              </option>
            ))
          )}
        </select>
      </label>
      {selected ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-text-secondary">
          <Webhook className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate">{subscriptionResourceLabel(selected)}</span>
          <span className="shrink-0 text-text-muted">{sourceName(selected.sourceType)}</span>
        </div>
      ) : (
        <p className={automationClass('execution-hint')}>
          {t('todo.automation_event_subscription_manage_hint')}
        </p>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

export function EventSubscriptionManager({
  api,
  projectId,
  catalog,
  canManage,
}: {
  api?: IncomingHookApi
  projectId?: string
  catalog: ProjectEventSourceCatalogItem[]
  canManage: boolean
}) {
  const { t } = useTranslation('common')
  const [subscriptions, setSubscriptions] = useState<ProjectIncomingHook[]>([])
  const [draft, setDraft] = useState<SubscriptionDraft>(() => emptyDraft(catalog))
  const [editorOpen, setEditorOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedValue, setCopiedValue] = useState<string | null>(null)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})
  const [eventsBySubscription, setEventsBySubscription] = useState<
    Record<string, ProjectIncomingEvent[]>
  >({})
  const [expandedSubscriptionId, setExpandedSubscriptionId] = useState<string | null>(null)

  const availableSources = useMemo(
    () => catalog.filter(item => item.sourceType !== 'wework'),
    [catalog]
  )
  const selectedSource =
    availableSources.find(item => item.sourceType === draft.sourceType) ?? availableSources[0]
  const needsCredential = draft.collectionMode === 'poll' || draft.collectionMode === 'hybrid'

  const load = useCallback(async () => {
    if (!api || !projectId) return
    try {
      setSubscriptions(await api.list(projectId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_load_failed'))
    }
  }, [api, projectId, t])

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  async function createSubscription() {
    if (
      !api ||
      !projectId ||
      busyId ||
      !draft.resourceUrl.trim() ||
      (needsCredential && !draft.credentialRef.trim())
    ) {
      return
    }
    setBusyId('create')
    setError(null)
    try {
      const subscription = await api.create(projectId, {
        name: draft.name.trim() || `${sourceName(draft.sourceType)} subscription`,
        sourceType: draft.sourceType,
        collectionMode: draft.collectionMode,
        resource: { url: draft.resourceUrl.trim() },
        pollIntervalSeconds: needsCredential ? draft.pollIntervalSeconds : null,
        credentialRef: needsCredential ? draft.credentialRef.trim() : null,
      })
      if (subscription.webhookSecret) {
        setRevealedSecrets(current => ({
          ...current,
          [subscription.id]: subscription.webhookSecret!,
        }))
      }
      setSubscriptions(current => [...current, subscription])
      setDraft(emptyDraft(catalog))
      setEditorOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_create_failed'))
    } finally {
      setBusyId(null)
    }
  }

  async function updateStatus(subscription: ProjectIncomingHook) {
    if (!api || !projectId || busyId) return
    setBusyId(subscription.id)
    try {
      const updated = await api.update(projectId, subscription.id, {
        version: subscription.version,
        status: subscription.status === 'active' ? 'disabled' : 'active',
      })
      setSubscriptions(current => current.map(item => (item.id === updated.id ? updated : item)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_update_failed'))
    } finally {
      setBusyId(null)
    }
  }

  async function removeSubscription(subscription: ProjectIncomingHook) {
    if (
      !api ||
      !projectId ||
      busyId ||
      !window.confirm(t('todo.event_subscription_delete_confirm', { name: subscription.name }))
    ) {
      return
    }
    setBusyId(subscription.id)
    try {
      await api.remove(projectId, subscription.id)
      setSubscriptions(current => current.filter(item => item.id !== subscription.id))
      setExpandedSubscriptionId(current => (current === subscription.id ? null : current))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_delete_failed'))
    } finally {
      setBusyId(null)
    }
  }

  async function rotateSubscription(subscription: ProjectIncomingHook) {
    if (
      !api ||
      !projectId ||
      busyId ||
      !window.confirm(t('todo.event_subscription_rotate_confirm'))
    ) {
      return
    }
    setBusyId(subscription.id)
    try {
      const updated = await api.rotate(projectId, subscription.id)
      setSubscriptions(current => current.map(item => (item.id === updated.id ? updated : item)))
      if (updated.webhookSecret) {
        setRevealedSecrets(current => ({ ...current, [updated.id]: updated.webhookSecret! }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_rotate_failed'))
    } finally {
      setBusyId(null)
    }
  }

  async function revealSecret(subscription: ProjectIncomingHook) {
    if (!api || !projectId || busyId) return
    if (revealedSecrets[subscription.id]) {
      setRevealedSecrets(current => {
        const next = { ...current }
        delete next[subscription.id]
        return next
      })
      return
    }
    setBusyId(subscription.id)
    try {
      const result = await api.revealSecret(projectId, subscription.id)
      setRevealedSecrets(current => ({ ...current, [subscription.id]: result.webhookToken }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.event_subscription_reveal_failed'))
    } finally {
      setBusyId(null)
    }
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedValue(value)
      window.setTimeout(() => setCopiedValue(current => (current === value ? null : current)), 1500)
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
      <p className={automationClass('panel-help')}>{t('todo.event_subscription_unavailable')}</p>
    )
  }

  return (
    <section className="grid gap-4" data-testid="project-event-subscriptions">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{t('todo.event_subscription_title')}</h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('todo.event_subscription_project_description')}
          </p>
        </div>
        <button
          type="button"
          data-testid="event-subscription-add"
          disabled={!canManage || busyId !== null}
          onClick={() => setEditorOpen(true)}
          className={automationClass('project-primary-action')}
        >
          <Plus className="h-4 w-4" />
          {t('todo.event_subscription_add')}
        </button>
      </div>

      {editorOpen ? (
        <div
          className="grid gap-4 rounded-2xl border border-border bg-background p-5 shadow-sm"
          data-testid="event-subscription-editor"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <strong className="text-sm font-medium">{t('todo.event_subscription_create')}</strong>
              <p className="mt-1 text-xs text-text-muted">
                {t('todo.event_subscription_create_description')}
              </p>
            </div>
            <button
              type="button"
              data-testid="event-subscription-cancel"
              onClick={() => setEditorOpen(false)}
              className="grid size-8 place-items-center rounded-lg text-text-muted hover:bg-muted"
              aria-label={t('common.cancel')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={automationClass('panel-field')}>
              <span>{t('todo.event_subscription_name')}</span>
              <input
                data-testid="event-subscription-name"
                value={draft.name}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className={automationClass('panel-field')}>
              <span>{t('todo.event_subscription_source_type')}</span>
              <select
                data-testid="event-subscription-source-type"
                value={draft.sourceType}
                onChange={event => {
                  const sourceType = event.target.value as ProjectEventSourceType
                  const source = availableSources.find(item => item.sourceType === sourceType)
                  setDraft(current => ({
                    ...current,
                    sourceType,
                    collectionMode:
                      source?.collectionModes.find(mode => mode === 'webhook') ??
                      source?.collectionModes[0] ??
                      'webhook',
                  }))
                }}
              >
                {availableSources.map(source => (
                  <option key={source.sourceType} value={source.sourceType}>
                    {sourceName(source.sourceType)}
                  </option>
                ))}
              </select>
            </label>
            <label className={automationClass('panel-field')}>
              <span>{t('todo.event_subscription_collection_mode')}</span>
              <select
                data-testid="event-subscription-collection-mode"
                value={draft.collectionMode}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    collectionMode: event.target.value as ProjectEventCollectionMode,
                  }))
                }
              >
                {(selectedSource?.collectionModes ?? []).map(mode => (
                  <option key={mode} value={mode}>
                    {t(`todo.event_subscription_mode_${mode}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={automationClass('panel-field')}>
              <span>{t('todo.event_subscription_resource_url')}</span>
              <input
                data-testid="event-subscription-resource-url"
                value={draft.resourceUrl}
                onChange={event =>
                  setDraft(current => ({ ...current, resourceUrl: event.target.value }))
                }
                placeholder={
                  draft.sourceType === 'gitlab'
                    ? 'https://gitlab.com/group/project'
                    : 'https://github.com/owner/repository'
                }
              />
            </label>
            {needsCredential ? (
              <>
                <label className={automationClass('panel-field')}>
                  <span>{t('todo.event_subscription_interval')}</span>
                  <div className={automationClass('poll-interval-control')}>
                    <input
                      data-testid="event-subscription-poll-interval"
                      type="number"
                      min={1}
                      max={1440}
                      value={Math.max(1, Math.round(draft.pollIntervalSeconds / 60))}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          pollIntervalSeconds: Math.max(1, Number(event.target.value) || 1) * 60,
                        }))
                      }
                    />
                    <span>{t('todo.event_subscription_minutes')}</span>
                  </div>
                </label>
                <label className={automationClass('panel-field')}>
                  <span>{t('todo.event_subscription_credential')}</span>
                  <input
                    data-testid="event-subscription-credential"
                    value={draft.credentialRef}
                    onChange={event =>
                      setDraft(current => ({ ...current, credentialRef: event.target.value }))
                    }
                    placeholder={t('todo.event_subscription_credential_placeholder')}
                  />
                </label>
              </>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className={automationClass('project-secondary-action')}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="event-subscription-save"
              disabled={
                busyId !== null ||
                !draft.resourceUrl.trim() ||
                (needsCredential && !draft.credentialRef.trim())
              }
              onClick={() => void createSubscription()}
              className={automationClass('project-primary-action')}
            >
              {t('todo.event_subscription_save')}
            </button>
          </div>
        </div>
      ) : null}

      {subscriptions.length ? (
        <div className="grid gap-3">
          {subscriptions.map(subscription => {
            const secret = revealedSecrets[subscription.id]
            const events = eventsBySubscription[subscription.id]
            const healthy =
              subscription.status === 'active' && subscription.health?.status !== 'error'
            return (
              <article
                key={subscription.id}
                data-testid={`event-subscription-card-${subscription.id}`}
                className="overflow-hidden rounded-2xl border border-border bg-background"
              >
                <div className="grid gap-4 p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-text-secondary">
                      <Webhook className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{subscription.name}</h3>
                        <span
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-text-secondary',
                            healthy && 'bg-success/10 text-success',
                            subscription.health?.status === 'error' &&
                              'bg-destructive/10 text-destructive'
                          )}
                        >
                          <i className="size-1.5 rounded-full bg-current" />
                          {subscription.status === 'disabled'
                            ? t('todo.event_subscription_status_disabled')
                            : subscription.health?.status === 'error'
                              ? t('todo.event_subscription_status_error')
                              : t('todo.event_subscription_status_active')}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm text-text-secondary">
                        {sourceName(subscription.sourceType)} ·{' '}
                        {t(`todo.event_subscription_mode_${subscription.collectionMode}`)} ·{' '}
                        {subscriptionResourceLabel(subscription)}
                      </p>
                    </div>
                    <PopupMenu
                      testId={`event-subscription-actions-${subscription.id}`}
                      menuWidth={168}
                      triggerClassName="grid size-8 place-items-center rounded-lg text-text-muted hover:bg-muted"
                      ariaLabel={t('todo.event_subscription_actions')}
                      trigger={<MoreHorizontal className="h-4 w-4" />}
                    >
                      {close => (
                        <>
                          <button
                            type="button"
                            data-testid={`event-subscription-toggle-${subscription.id}`}
                            onClick={() => {
                              close()
                              void updateStatus(subscription)
                            }}
                            className={automationClass('card-menu-action')}
                          >
                            {subscription.status === 'active'
                              ? t('todo.event_subscription_disable')
                              : t('todo.event_subscription_enable')}
                          </button>
                          {subscription.webhookUrl ? (
                            <button
                              type="button"
                              data-testid={`event-subscription-rotate-${subscription.id}`}
                              onClick={() => {
                                close()
                                void rotateSubscription(subscription)
                              }}
                              className={automationClass('card-menu-action')}
                            >
                              <RefreshCw className="h-4 w-4" />
                              {t('todo.event_subscription_rotate_short')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            data-testid={`event-subscription-delete-${subscription.id}`}
                            onClick={() => {
                              close()
                              void removeSubscription(subscription)
                            }}
                            className={automationClass('card-menu-action danger')}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('common.delete')}
                          </button>
                        </>
                      )}
                    </PopupMenu>
                  </div>

                  {subscription.webhookUrl ? (
                    <div className="grid gap-3 rounded-xl bg-muted/40 p-4">
                      <div className="grid gap-1.5">
                        <span className="text-xs text-text-muted">
                          {t('todo.automation_event_subscription_webhook_url')}
                        </span>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all text-code text-text-secondary">
                            {subscription.webhookUrl}
                          </code>
                          <Tooltip label={t('todo.event_subscription_copy_url')}>
                            <button
                              type="button"
                              data-testid={`event-subscription-copy-url-${subscription.id}`}
                              onClick={() => void copyValue(subscription.webhookUrl!)}
                              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-background hover:text-text-primary"
                              aria-label={t('todo.event_subscription_copy_url')}
                            >
                              {copiedValue === subscription.webhookUrl ? (
                                <Check className="h-4 w-4" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <span className="text-xs text-text-muted">
                          {t('todo.event_subscription_signing_secret')}
                        </span>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate text-code text-text-secondary">
                            {secret ?? '••••••••••••••••••••••••'}
                          </code>
                          {secret ? (
                            <Tooltip label={t('todo.event_subscription_copy_secret')}>
                              <button
                                type="button"
                                onClick={() => void copyValue(secret)}
                                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-background hover:text-text-primary"
                                aria-label={t('todo.event_subscription_copy_secret')}
                              >
                                <Copy className="h-4 w-4" />
                              </button>
                            </Tooltip>
                          ) : null}
                          <Tooltip
                            label={
                              secret
                                ? t('todo.event_subscription_hide_secret')
                                : t('todo.event_subscription_reveal_secret')
                            }
                          >
                            <button
                              type="button"
                              data-testid={`event-subscription-reveal-${subscription.id}`}
                              onClick={() => void revealSecret(subscription)}
                              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-background hover:text-text-primary"
                              aria-label={
                                secret
                                  ? t('todo.event_subscription_hide_secret')
                                  : t('todo.event_subscription_reveal_secret')
                              }
                            >
                              {secret ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {subscription.health?.lastError ? (
                    <p className="text-xs text-destructive">{subscription.health.lastError}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  data-testid={`event-subscription-events-${subscription.id}`}
                  onClick={() => void toggleEvents(subscription)}
                  className="flex h-10 w-full items-center gap-2 border-t border-border px-5 text-sm text-text-secondary hover:bg-muted/40 hover:text-text-primary"
                >
                  <History className="h-4 w-4" />
                  {expandedSubscriptionId === subscription.id
                    ? t('todo.event_subscription_hide_events')
                    : t('todo.event_subscription_show_events')}
                  <ChevronDown
                    className={cn(
                      'ml-auto h-4 w-4 transition-transform',
                      expandedSubscriptionId === subscription.id && 'rotate-180'
                    )}
                  />
                </button>
                {expandedSubscriptionId === subscription.id ? (
                  <div
                    className="grid gap-1 border-t border-border bg-muted/20 p-3"
                    aria-live="polite"
                  >
                    {events ? (
                      events.length ? (
                        events.map(event => (
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
                                'shrink-0 text-text-muted',
                                event.status === 'failed' && 'text-destructive'
                              )}
                            >
                              {event.status}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="px-2 py-3 text-xs text-text-muted">
                          {t('todo.event_subscription_no_events')}
                        </p>
                      )
                    ) : (
                      <p className="px-2 py-3 text-xs text-text-muted">
                        {t('todo.event_subscription_loading_events')}
                      </p>
                    )}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="grid min-h-56 place-items-center content-center gap-2 rounded-2xl border border-dashed border-border text-center">
          <Webhook className="h-6 w-6 text-text-muted" />
          <strong className="text-sm font-medium">{t('todo.event_subscription_empty')}</strong>
          <span className="max-w-md text-sm text-text-muted">
            {t('todo.event_subscription_empty_description')}
          </span>
        </div>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  )
}
