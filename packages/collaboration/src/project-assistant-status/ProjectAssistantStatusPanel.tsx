import { useId, type ReactNode } from 'react'
import { projectAssistantStatusEnglish } from './copy'
import {
  formatReceiptTime,
  hostingRecoveryAction,
  projectAssistantManagerSummary,
  projectAssistantStatus,
} from './projection'
import type {
  ProjectAssistantStatus,
  ProjectAssistantStatusCopy,
} from './types'
import './project-assistant-status.css'

export interface ProjectAssistantStatusPanelProps {
  /** Self receives the proposed full DTO; manager receives only its minimal DTO. */
  status?: unknown
  audience?: 'self' | 'manager'
  projectName?: string
  copy?: ProjectAssistantStatusCopy
  locale?: string
  timeZone?: string
  loading?: boolean
  error?: boolean
  featureEnabled?: boolean
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

function hostingLabel(
  snapshot: ProjectAssistantStatus,
  copy: ProjectAssistantStatusCopy,
) {
  if (!snapshot.enabled)
    return snapshot.reasonCode === 'hosting_paused'
      ? copy.paused
      : copy.notEnabled
  return snapshot.reasonCode === 'permission_revoked'
    ? copy.revoked
    : copy.enabled
}

export function ProjectAssistantStatusPanel({
  status,
  projectName,
  audience = 'self',
  copy = projectAssistantStatusEnglish,
  locale = 'en',
  timeZone = 'Asia/Shanghai',
  loading = false,
  error = false,
  featureEnabled = true,
  onOpenSettings,
  onOpenRules,
  onOpenReceipt,
}: ProjectAssistantStatusPanelProps) {
  const headingId = useId()
  if (!featureEnabled) return null
  if (audience === 'manager') {
    const summary = projectAssistantManagerSummary(status)
    return (
      <section
        className="project-assistant-status"
        data-testid="project-assistant-status-manager"
        aria-labelledby={headingId}
      >
        <header className="project-assistant-status__header">
          <h2 id={headingId}>{copy.managerHeading}</h2>
        </header>
        <dl className="project-assistant-status__facts">
          <Fact label={copy.dispatchable}>
            {loading || error || summary.dispatchable === null
              ? copy.pending
              : summary.dispatchable
                ? copy.yes
                : copy.no}
          </Fact>
          <Fact label={copy.availability}>
            {loading || error
              ? copy.pending
              : copy.availabilityValues[summary.availability]}
          </Fact>
        </dl>
      </section>
    )
  }
  const snapshot = projectAssistantStatus(status)
  const unavailable = loading || error || !snapshot
  const stateLabel = loading
    ? copy.loading
    : error
      ? copy.error
      : snapshot
        ? hostingLabel(snapshot, copy)
        : copy.unknown
  const panelState = loading
    ? 'loading'
    : error
      ? 'error'
      : (snapshot?.reasonCode ?? (snapshot ? 'hosting' : 'unknown'))
  return (
    <section
      className="project-assistant-status"
      data-state={panelState}
      data-testid="project-assistant-status"
      aria-labelledby={headingId}
    >
      <header className="project-assistant-status__header">
        <div>
          <span className="project-assistant-status__eyebrow">
            {copy.ownerHeading}
          </span>
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
      {unavailable ? (
        <p className="project-assistant-status__notice">
          {loading
            ? copy.loadingDetail
            : error
              ? copy.errorDetail
              : copy.unknownDetail}
        </p>
      ) : (
        <>
          <HostingFacts
            snapshot={snapshot}
            copy={copy}
            locale={locale}
            timeZone={timeZone}
          />
          {snapshot.reasonCode && (
            <p
              className="project-assistant-status__notice"
              data-testid="project-assistant-reason"
            >
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
        <span>
          {snapshot?.synthetic ? copy.fixtureNote : copy.projectionNote}
        </span>
        {!unavailable && (
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
      <Fact label={copy.availability}>
        {copy.availabilityValues[snapshot.availability]}
      </Fact>
      <Fact label={copy.lastReceipt}>
        <time dateTime={snapshot.lastReceiptAt ?? undefined}>
          {formatReceiptTime(
            snapshot.lastReceiptAt,
            copy.noReceiptTime,
            locale,
            timeZone,
          )}
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
} & Pick<
  ProjectAssistantStatusPanelProps,
  'onOpenSettings' | 'onOpenRules' | 'onOpenReceipt'
>) {
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
        <button
          type="button"
          data-testid="project-assistant-recovery"
          onClick={() => recovery(snapshot)}
        >
          {labels[action]}
        </button>
      )}
      {onOpenSettings && action !== 'settings' && (
        <button
          type="button"
          data-testid="project-assistant-settings"
          onClick={() => onOpenSettings(snapshot)}
        >
          {copy.settingsAction}
        </button>
      )}
      {snapshot.receipt && onOpenReceipt && action !== 'receipt' && (
        <button
          type="button"
          data-testid="project-assistant-receipt"
          onClick={() => onOpenReceipt(snapshot)}
        >
          {copy.receiptAction}
        </button>
      )}
    </>
  )
}
