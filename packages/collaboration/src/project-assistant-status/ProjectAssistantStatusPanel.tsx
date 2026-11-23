import { useId, type ReactNode } from 'react'
import { Button as ControlButton } from '../markdown/Button'
import { projectAssistantStatusEnglish } from './copy'
import './project-assistant-status.css'
import {
  formatReceiptTime,
  hostingRecoveryAction,
  projectAssistantManagerSummary,
  projectAssistantStatus,
} from './projection'
import type {
  ProjectAssistantManagerSummary,
  ProjectAssistantScope,
  ProjectAssistantStatus,
  ProjectAssistantStatusCopy,
} from './types'

export interface ProjectAssistantStatusPanelProps {
  /** Current request context. A snapshot from another project/store is hidden. */
  projectScope: ProjectAssistantScope
  /** Self receives the proposed full DTO; manager receives only its minimal DTO. */
  status?: unknown
  /** Response envelope identity for the minimal manager DTO, never private data. */
  statusScope?: ProjectAssistantScope
  audience?: 'self' | 'manager'
  projectName?: string
  copy?: ProjectAssistantStatusCopy
  locale?: string
  timeZone?: string
  loading?: boolean
  error?: boolean
  featureEnabled?: boolean
  /** Requests a read refresh only; the host owns fetching and response ordering. */
  onRetry?(): void
  onOpenSettings?(snapshot: ProjectAssistantStatus): void
  onOpenRules?(snapshot: ProjectAssistantStatus): void
  onOpenReceipt?(snapshot: ProjectAssistantStatus): void
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function hostingLabel(snapshot: ProjectAssistantStatus, copy: ProjectAssistantStatusCopy) {
  if (!snapshot.enabled)
    return snapshot.reasonCode === 'hosting_paused' ? copy.paused : copy.notEnabled
  return snapshot.reasonCode === 'permission_revoked' ? copy.revoked : copy.enabled
}

type SyncState = 'ready' | 'loading' | 'refreshing' | 'error' | 'stale' | 'unknown'

function matchesScope(current: ProjectAssistantScope, snapshot?: ProjectAssistantScope | null) {
  return (
    (current?.projectStore === 'local' || current?.projectStore === 'cloud') &&
    !!current.projectId?.trim() &&
    current.projectStore === snapshot?.projectStore &&
    current.projectId === snapshot.projectId
  )
}

function managerSnapshot(value: unknown): ProjectAssistantManagerSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return projectAssistantManagerSummary(value)
}

function syncState(hasSnapshot: boolean, loading: boolean, error: boolean): SyncState {
  if (loading) return hasSnapshot ? 'refreshing' : 'loading'
  if (error) return hasSnapshot ? 'stale' : 'error'
  return hasSnapshot ? 'ready' : 'unknown'
}

function SyncNotice({ state, copy }: { state: SyncState; copy: ProjectAssistantStatusCopy }) {
  if (state === 'ready') return null
  const failed = state === 'error' || state === 'stale'
  const [label, detail] = {
    loading: [copy.loading, copy.loadingDetail],
    refreshing: [copy.refreshing, copy.refreshingDetail],
    error: [copy.error, copy.errorDetail],
    stale: [copy.error, copy.staleDetail],
    unknown: [copy.unknown, copy.unknownDetail],
  }[state]
  return (
    <p
      className="project-assistant-status__notice"
      data-testid="project-assistant-sync-state"
      data-state={state}
      role={failed ? 'alert' : 'status'}
    >
      <strong>{label}</strong>
      <span>{detail}</span>
    </p>
  )
}

function RetryAction({
  state,
  copy,
  onRetry,
}: {
  state: SyncState
  copy: ProjectAssistantStatusCopy
  onRetry?: () => void
}) {
  if (!onRetry || (state !== 'error' && state !== 'stale')) return null
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid="project-assistant-retry"
      onClick={onRetry}
    >
      {copy.retryAction}
    </ControlButton>
  )
}

export function ProjectAssistantStatusPanel({
  projectScope,
  status,
  statusScope,
  projectName,
  audience = 'self',
  copy = projectAssistantStatusEnglish,
  locale = 'en',
  timeZone = 'Asia/Shanghai',
  loading = false,
  error = false,
  featureEnabled = true,
  onRetry,
  onOpenSettings,
  onOpenRules,
  onOpenReceipt,
}: ProjectAssistantStatusPanelProps) {
  const headingId = useId()
  if (!featureEnabled) return null
  if (audience === 'manager') {
    const summary = matchesScope(projectScope, statusScope) ? managerSnapshot(status) : null
    const state = syncState(!!summary, loading, error)
    return (
      <section
        className="project-assistant-status"
        data-testid="project-assistant-status-manager"
        data-state={state}
        aria-labelledby={headingId}
      >
        <header className="project-assistant-status__header">
          <h2 id={headingId}>{copy.managerHeading}</h2>
        </header>
        <SyncNotice state={state} copy={copy} />
        <dl className="project-assistant-status__facts">
          <Fact label={copy.dispatchable}>
            {summary?.dispatchable == null
              ? copy.pending
              : summary.dispatchable
                ? copy.yes
                : copy.no}
          </Fact>
          <Fact label={copy.availability}>
            {!summary ? copy.pending : copy.availabilityValues[summary.availability]}
          </Fact>
        </dl>
        <footer className="project-assistant-status__footer">
          <RetryAction state={state} copy={copy} onRetry={onRetry} />
        </footer>
      </section>
    )
  }
  const candidate = projectAssistantStatus(status)
  const snapshot = matchesScope(projectScope, candidate) ? candidate : null
  const state = syncState(!!snapshot, loading, error)
  const stateLabel = snapshot
    ? hostingLabel(snapshot, copy)
    : loading
      ? copy.loading
      : error
        ? copy.error
        : copy.unknown
  const panelState = state === 'ready' ? (snapshot?.reasonCode ?? 'hosting') : state
  return (
    <section
      className="project-assistant-status"
      data-state={panelState}
      data-testid="project-assistant-status"
      aria-labelledby={headingId}
    >
      <header className="project-assistant-status__header">
        <div>
          <span className="project-assistant-status__eyebrow">{copy.ownerHeading}</span>
          <h2 id={headingId}>{projectName || copy.projectFallback}</h2>
        </div>
        <strong
          className="project-assistant-status__state"
          data-testid="project-assistant-hosting-state"
          role="status"
        >
          {stateLabel}
        </strong>
      </header>
      <SyncNotice state={state} copy={copy} />
      {snapshot && (
        <>
          <HostingFacts snapshot={snapshot} copy={copy} locale={locale} timeZone={timeZone} />
          {snapshot.reasonCode && (
            <p className="project-assistant-status__notice" data-testid="project-assistant-reason">
              <strong>{copy.reasonLabels[snapshot.reasonCode]}</strong>
              <span>{copy.reasonDetails[snapshot.reasonCode]}</span>
              <code>{snapshot.reasonCode}</code>
            </p>
          )}
          <AssignmentReceipt snapshot={snapshot} copy={copy} />
          <p className="project-assistant-status__policy">
            {snapshot.enabled ? copy.enabledPolicy : copy.pausedPolicy}
          </p>
        </>
      )}
      <footer className="project-assistant-status__footer">
        <span>{snapshot?.synthetic ? copy.fixtureNote : copy.projectionNote}</span>
        <RetryAction state={state} copy={copy} onRetry={onRetry} />
        {snapshot && (
          <HostingActions
            snapshot={snapshot}
            copy={copy}
            onOpenSettings={onOpenSettings}
            onOpenRules={onOpenRules}
            onOpenReceipt={onOpenReceipt}
          />
        )}
      </footer>
    </section>
  )
}

function HostingFacts({
  snapshot,
  copy,
  locale,
  timeZone,
}: {
  snapshot: ProjectAssistantStatus
  copy: ProjectAssistantStatusCopy
  locale: string
  timeZone: string
}) {
  const scopeLabel =
    snapshot.scope.kind === 'project'
      ? copy.projectScope
      : snapshot.scope.kind === 'tags'
        ? copy.tagScope
        : copy.scopeUnknown
  const tagMatch =
    snapshot.tagMatch === true
      ? copy.matched
      : snapshot.tagMatch === false
        ? copy.unmatched
        : copy.tagMatchUnknown
  return (
    <dl className="project-assistant-status__facts">
      <Fact label={copy.scope}>{scopeLabel}</Fact>
      <Fact label={copy.coveredTags}>
        {snapshot.scope.kind === 'project'
          ? copy.allTags
          : snapshot.scope.kind === 'tags' && snapshot.scope.tagIds.length
            ? snapshot.scope.tagIds.join(', ')
            : copy.scopeUnknown}
      </Fact>
      <Fact label={copy.currentTags}>
        {snapshot.currentTags.join(', ') || copy.noTags} · {tagMatch}
      </Fact>
      <Fact label={copy.availability}>{copy.availabilityValues[snapshot.availability]}</Fact>
      <Fact label={copy.lastReceipt}>
        <time dateTime={snapshot.lastReceiptAt ?? undefined}>
          {formatReceiptTime(snapshot.lastReceiptAt, copy.noReceiptTime, locale, timeZone)}
        </time>
      </Fact>
    </dl>
  )
}

function AssignmentReceipt({
  snapshot,
  copy,
}: {
  snapshot: ProjectAssistantStatus
  copy: ProjectAssistantStatusCopy
}) {
  const receipt = snapshot.receipt
  const missingEvidence = receipt?.state === 'completed' && !receipt.deliveryRef
  const label = missingEvidence
    ? copy.incompleteEvidence
    : receipt
      ? copy.assignmentStates[receipt.state]
      : copy.noReceipt
  return (
    <div
      className="project-assistant-status__receipt"
      data-testid="project-assistant-assignment-state"
    >
      <span>{copy.assignment}</span>
      <strong>{label}</strong>
      {missingEvidence && <small>{copy.incompleteEvidenceDetail}</small>}
    </div>
  )
}

function HostingActions({
  snapshot,
  copy,
  onOpenSettings,
  onOpenRules,
  onOpenReceipt,
}: {
  snapshot: ProjectAssistantStatus
  copy: ProjectAssistantStatusCopy
} & Pick<ProjectAssistantStatusPanelProps, 'onOpenSettings' | 'onOpenRules' | 'onOpenReceipt'>) {
  const action = hostingRecoveryAction(snapshot.reasonCode)
  const callbacks = {
    settings: onOpenSettings,
    rules: onOpenRules,
    receipt: snapshot.receipt ? onOpenReceipt : undefined,
  }
  const labels = {
    settings: copy.settingsAction,
    rules: copy.rulesAction,
    receipt: copy.receiptAction,
  }
  const recovery = action && callbacks[action]
  return (
    <>
      {action && recovery && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="project-assistant-recovery"
          onClick={() => recovery(snapshot)}
        >
          {labels[action]}
        </ControlButton>
      )}
      {onOpenSettings && action !== 'settings' && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="project-assistant-settings"
          onClick={() => onOpenSettings(snapshot)}
        >
          {copy.settingsAction}
        </ControlButton>
      )}
      {snapshot.receipt && onOpenReceipt && action !== 'receipt' && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="project-assistant-receipt"
          onClick={() => onOpenReceipt(snapshot)}
        >
          {copy.receiptAction}
        </ControlButton>
      )}
    </>
  )
}
