import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Textarea } from '@wegent/collaboration/controls/Textarea'
import {
  cancelWebsiteCapture,
  finishWebsiteCapture,
  installWebsiteConnection,
  matchWebsiteConnections,
  startWebsiteCapture,
  testWebsiteConnection,
  type WebConnectionTrial,
} from '@/api/webConnections'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import { describeDshExecutor } from '@/api/dsh/executorTransport'
import { Button } from '@/components/ui/button'
import { restartCoreDsh } from '@/features/dsh-plugins/coreDshPlugins'
import { generateWebsiteConnection } from '@/features/todo/generateWebsiteConnection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo, toBrowserPath } from '@/lib/navigation'

type Stage =
  | { kind: 'matching' }
  | { kind: 'matched'; providers: ConnectionProviderDescriptor[] }
  | { kind: 'intent' }
  | { kind: 'recording'; id: string; elapsed?: true }
  | { kind: 'generating' }
  | { kind: 'trial' }
  | {
      kind: 'trial-ready'
      id: string
      authored: Awaited<ReturnType<typeof generateWebsiteConnection>>
    }
  | {
      kind: 'preview'
      trial: WebConnectionTrial
      authored: Awaited<ReturnType<typeof generateWebsiteConnection>>
    }
  | { kind: 'installed'; providerId: string }
  | { kind: 'error'; key: 'match' | 'capture' | 'generation' | 'trial' | 'install' | 'model' }

function trialField(
  read: Record<string, unknown>,
  field: string,
  value: unknown,
  language: string
) {
  const schema = read.itemSchema as
    | { properties?: Record<string, { title?: string; format?: string }> }
    | undefined
  const property = schema?.properties?.[field]
  const label = typeof property?.title === 'string' ? property.title.slice(0, 100) : field
  const units = read.displayUnits as Record<string, unknown> | undefined
  let formatted = typeof value === 'string' ? value : (JSON.stringify(value) ?? '—')
  if (typeof value === 'number') {
    const unit = units?.[field]
    const displayUnit =
      unit === 'millisecond' && value !== 0 && value % 60_000 === 0 ? 'minute' : unit
    const displayValue = unit === displayUnit ? value : value / 60_000
    formatted =
      displayUnit === 'millisecond' ||
      displayUnit === 'second' ||
      displayUnit === 'minute' ||
      displayUnit === 'hour'
        ? new Intl.NumberFormat(language, { style: 'unit', unit: displayUnit }).format(displayValue)
        : new Intl.NumberFormat(language).format(value)
  }
  if (
    property?.format === 'date-time' &&
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value))
  ) {
    formatted = new Date(value).toLocaleString(language)
  }
  return { label, formatted }
}

export function WebsiteConnectionPanel({
  label,
  url,
  services,
  onClose,
}: {
  label: string
  url: string
  services: WorkbenchServices
  onClose(): void
}) {
  const { t, i18n } = useTranslation('common')
  const [stage, setStage] = useState<Stage>({ kind: 'matching' })
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState('')
  const started = useRef(false)
  const owner = useRef(new AbortController())
  const recordingTimer = useRef<number | undefined>(undefined)
  const captured = useRef<string | undefined>(undefined)
  const preview = stage.kind === 'preview' ? stage : undefined
  const firstRow = preview?.trial.page.items[0] ?? preview?.trial.continuation?.items[0]
  const trialMatch =
    preview?.trial.collection.events[0] ?? preview?.trial.collectionContinuation?.events[0]
  const threshold = preview?.trial.threshold
  const thresholdField =
    threshold && preview
      ? trialField(
          preview.authored.definition.read,
          threshold.field,
          threshold.value,
          i18n.language
        )
      : undefined

  function discardCapture() {
    window.clearTimeout(recordingTimer.current)
    const id = captured.current
    captured.current = undefined
    if (id) void cancelWebsiteCapture(label, id).catch(() => undefined)
  }

  async function match() {
    setStage({ kind: 'matching' })
    try {
      const result = await matchWebsiteConnections(url)
      if (!owner.current.signal.aborted)
        setStage(
          result.items.length ? { kind: 'matched', providers: result.items } : { kind: 'intent' }
        )
    } catch {
      if (!owner.current.signal.aborted) setStage({ kind: 'error', key: 'match' })
    }
  }

  function bindPanel(element: HTMLElement | null) {
    if (!element || started.current) return
    started.current = true
    void match()
  }

  async function openConnection(providerId: string, restart = false) {
    setBusy(true)
    try {
      const identity = await describeDshExecutor()
      const route = `/stand-in?${new URLSearchParams({
        profileId: '@primary',
        deviceId: identity.device_id,
        settingsRequest: crypto.randomUUID(),
        connectionProvider: providerId,
      })}`
      if (restart) await restartCoreDsh(toBrowserPath(route))
      else navigateTo(route)
      onClose()
    } catch {
      setDetail(t('workbench.web_connection_open_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function startRecording() {
    setBusy(true)
    setDetail('')
    try {
      const { id, durationMs } = await startWebsiteCapture(label)
      if (owner.current.signal.aborted) {
        await cancelWebsiteCapture(label, id)
        return
      }
      captured.current = id
      setStage({ kind: 'recording', id })
      recordingTimer.current = window.setTimeout(() => {
        setStage(current =>
          current.kind === 'recording' && current.id === id
            ? { ...current, elapsed: true }
            : current
        )
      }, durationMs)
    } catch {
      if (!owner.current.signal.aborted) setStage({ kind: 'error', key: 'capture' })
    } finally {
      setBusy(false)
    }
  }

  async function finishRecording(id: string) {
    window.clearTimeout(recordingTimer.current)
    const signal = owner.current.signal
    setStage({ kind: 'generating' })
    let failure: 'capture' | 'generation' = 'capture'
    try {
      const capture = await finishWebsiteCapture(label, id)
      if (!capture.requests.length) throw new Error('website_evidence_insufficient')
      signal.throwIfAborted()
      failure = 'generation'
      const authored = await generateWebsiteConnection({
        services,
        intent,
        label,
        captureId: id,
        capture,
        signal,
      })
      signal.throwIfAborted()
      await runTrial(id, authored)
    } catch (error) {
      if (signal.aborted) return
      setStage({
        kind: 'error',
        key:
          error instanceof Error && error.message === 'website_generation_unavailable'
            ? 'model'
            : failure,
      })
      if (failure === 'generation' && error instanceof Error && /\s/.test(error.message)) {
        setDetail(error.message.slice(0, 500))
      }
      discardCapture()
    }
  }

  async function runTrial(
    id: string,
    authored: Awaited<ReturnType<typeof generateWebsiteConnection>>
  ) {
    setStage({ kind: 'trial' })
    setDetail('')
    try {
      const trial = await testWebsiteConnection(label, id, authored.definition, authored.sample)
      if (!owner.current.signal.aborted) setStage({ kind: 'preview', trial, authored })
    } catch (error) {
      if (owner.current.signal.aborted) return
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'web_connection_trial_cancelled'
      ) {
        setStage({ kind: 'trial-ready', id, authored })
        return
      }
      setStage({ kind: 'error', key: 'trial' })
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'web_connection_sample_empty'
      ) {
        setDetail(t('workbench.web_connection_sample_empty'))
      }
    }
    discardCapture()
  }

  async function install(trial: WebConnectionTrial) {
    setBusy(true)
    setDetail('')
    try {
      const { providerId } = await installWebsiteConnection(trial.trialId)
      setStage({ kind: 'installed', providerId })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'web_connection_trial_required'
      ) {
        setStage({ kind: 'intent' })
        setDetail(t('workbench.web_connection_preview_expired'))
      } else {
        setDetail(t('workbench.web_connection_error_install'))
      }
    } finally {
      setBusy(false)
    }
  }

  function close() {
    owner.current.abort()
    discardCapture()
    onClose()
  }

  return (
    <section
      ref={bindPanel}
      aria-label={t('workbench.web_connection_title')}
      data-testid="website-connection-panel"
      className="shrink-0 space-y-2 border-b border-border bg-background px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className="font-medium">{t('workbench.web_connection_title')}</h2>
          <span className="truncate text-text-secondary">{new URL(url).host}</span>
          {stage.kind === 'recording' && !stage.elapsed && (
            <span
              data-testid="website-connection-recording-status"
              className="font-medium text-text-primary"
            >
              {t('workbench.web_connection_recording_status')}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('workbench.web_connection_close')}
          data-testid="website-connection-close"
          onClick={close}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {stage.kind === 'matching' && <p role="status">{t('workbench.web_connection_matching')}</p>}
      {stage.kind === 'matched' && (
        <div className="space-y-2">
          <ul className="space-y-1">
            {stage.providers.map(provider => (
              <li key={provider.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{provider.displayName}</span>
                <Button
                  disabled={busy}
                  size="sm"
                  variant="outline"
                  data-testid="website-connection-use-existing"
                  onClick={() => void openConnection(provider.id)}
                >
                  {t('workbench.web_connection_use_existing')}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            data-testid="website-connection-create-another"
            onClick={() => setStage({ kind: 'intent' })}
          >
            {t('workbench.web_connection_create_another')}
          </Button>
        </div>
      )}
      {(stage.kind === 'intent' ||
        stage.kind === 'recording' ||
        (stage.kind === 'error' && stage.key !== 'match')) && (
        <>
          <label className="block">
            <span className="mb-1 block">{t('workbench.web_connection_intent_label')}</span>
            <Textarea
              className="min-h-11 resize-y bg-background px-2 py-1.5 md:min-h-11"
              rows={2}
              data-testid="website-connection-intent"
              placeholder={t('workbench.web_connection_intent_placeholder')}
              maxLength={2000}
              value={intent}
              disabled={stage.kind === 'recording' || busy}
              onChange={event => setIntent(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className="text-text-secondary"
              role={stage.kind === 'recording' ? 'status' : undefined}
            >
              {t(
                stage.kind === 'recording'
                  ? stage.elapsed
                    ? 'workbench.web_connection_recording_elapsed'
                    : 'workbench.web_connection_recording'
                  : 'workbench.web_connection_capture_help'
              )}
            </p>
            {stage.kind === 'recording' ? (
              <Button
                size="sm"
                data-testid="website-connection-finish-recording"
                onClick={() => void finishRecording(stage.id)}
              >
                {t('workbench.web_connection_generate')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !intent.trim()}
                data-testid="website-connection-start-recording"
                onClick={() => void startRecording()}
              >
                {t(
                  stage.kind === 'error'
                    ? 'workbench.web_connection_record_again'
                    : 'workbench.web_connection_record'
                )}
              </Button>
            )}
          </div>
        </>
      )}
      {stage.kind === 'generating' && (
        <p role="status">{t('workbench.web_connection_generating')}</p>
      )}
      {stage.kind === 'trial' && (
        <p role="status" data-testid="website-connection-trial-pending">
          {t('workbench.web_connection_trial_pending')}
        </p>
      )}
      {stage.kind === 'trial-ready' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status">{t('workbench.web_connection_trial_cancelled')}</p>
          <Button
            size="sm"
            data-testid="website-connection-retry-trial"
            onClick={() => void runTrial(stage.id, stage.authored)}
          >
            {t('workbench.web_connection_native_allow')}
          </Button>
        </div>
      )}
      {stage.kind === 'error' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="alert">{t(`workbench.web_connection_error_${stage.key}`)}</p>
          {stage.key === 'match' && (
            <Button
              size="sm"
              variant="outline"
              data-testid="website-connection-retry-match"
              onClick={() => void match()}
            >
              {t('workbench.web_connection_retry')}
            </Button>
          )}
          {stage.key === 'model' && (
            <Button
              size="sm"
              variant="outline"
              data-testid="website-connection-model-settings"
              onClick={() => navigateTo('/settings/personal/models')}
            >
              {t('workbench.web_connection_model_settings')}
            </Button>
          )}
        </div>
      )}
      {stage.kind === 'preview' && (
        <div className="space-y-2" data-testid="website-connection-trial-result">
          <p className="font-medium">{stage.authored.definition.resource.name}</p>
          <p role="status">
            {t('workbench.web_connection_trial_passed', {
              rows: stage.trial.page.items.length + (stage.trial.continuation?.items.length ?? 0),
              events:
                stage.trial.collection.events.length +
                (stage.trial.collectionContinuation?.events.length ?? 0),
            })}
          </p>
          <p className="text-text-secondary">
            {t('workbench.web_connection_observation_window', {
              since: new Date(stage.trial.observationWindow.since).toLocaleString(i18n.language),
              until: new Date(stage.trial.observationWindow.until).toLocaleString(i18n.language),
            })}
          </p>
          {thresholdField && (
            <p className="text-text-secondary">
              {t('workbench.web_connection_observation_threshold', {
                field: thresholdField.label,
                value: thresholdField.formatted,
              })}
            </p>
          )}
          {firstRow && (
            <div className="rounded-md bg-muted p-2">
              <p className="mb-1 font-medium">{t('workbench.web_connection_query_example')}</p>
              <dl className="max-h-32 space-y-1 overflow-auto">
                {Object.entries(firstRow).map(([field, value]) => {
                  const { label, formatted } = trialField(
                    stage.authored.definition.read,
                    field,
                    value,
                    i18n.language
                  )
                  return (
                    <div key={field} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                      <dt className="break-words text-text-secondary">{label}</dt>
                      <dd className="break-words">{formatted}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          )}
          {trialMatch && (
            <p className="break-words" data-testid="website-connection-trial-match">
              {t('workbench.web_connection_match_example', { id: trialMatch.objectId })}
            </p>
          )}
          <p className="text-text-secondary">{t('workbench.web_connection_install_hint')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid="website-connection-edit-intent"
              onClick={() => {
                discardCapture()
                setDetail('')
                setStage({ kind: 'intent' })
              }}
            >
              {t('workbench.web_connection_edit_intent')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="website-connection-install"
              onClick={() => void install(stage.trial)}
            >
              {t('workbench.web_connection_install')}
            </Button>
          </div>
        </div>
      )}
      {stage.kind === 'installed' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status">{t('workbench.web_connection_installed')}</p>
          <Button
            size="sm"
            disabled={busy}
            data-testid="website-connection-open-installed"
            onClick={() => void openConnection(stage.providerId, true)}
          >
            {t('workbench.web_connection_add_to_assistant')}
          </Button>
        </div>
      )}
      {detail && (
        <p role="alert" className="text-text-secondary">
          {detail}
        </p>
      )}
    </section>
  )
}
