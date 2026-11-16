import { useEffect, useId, useRef, useState } from 'react'
import type {
  RuntimeCommandReceipt,
  RuntimeCommandTarget,
  RuntimeTaskCommandsApi,
} from '@/api/runtimeTaskCommands'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { formatIssueTimestamp } from '@wegent/collaboration'

interface RecoveryReviewProps {
  commands: RuntimeTaskCommandsApi
  deviceId: string
  target: RuntimeCommandTarget
  onCancel(): void
  onContinue(): Promise<void>
}

export function RuntimeCommandRecoveryReview(props: RecoveryReviewProps) {
  const { deviceId, target } = props
  return (
    <RecoveryReviewContent
      key={`${deviceId}:${target.userId}:${target.taskId}:${target.commandId}`}
      {...props}
    />
  )
}

function RecoveryReviewContent({
  commands,
  deviceId,
  target,
  onCancel,
  onContinue,
}: RecoveryReviewProps) {
  const { t } = useTranslation('common')
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [receipt, setReceipt] = useState<RuntimeCommandReceipt | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [continued, setContinued] = useState(false)
  const lock = useRef(false)
  const resolution = useRef<{ binding: string; requestId: string } | null>(null)
  const { taskId, commandId, userId } = target
  useEffect(() => {
    titleRef.current?.focus()
  }, [])
  useEffect(() => {
    let active = true
    void commands.get(deviceId, { taskId, commandId, userId }).then(
      result => {
        if (!active) return
        setReceipt(result)
        setLoading(false)
      },
      () => {
        if (!active) return
        setError(t('runtimeCommandRecovery.load_failed'))
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [commands, deviceId, taskId, commandId, userId, revision, t])

  const matches =
    receipt?.success === true &&
    receipt?.accepted === true &&
    receipt?.taskId === target.taskId &&
    receipt?.commandId === target.commandId &&
    !!receipt?.commandFingerprint &&
    receipt.native !== undefined &&
    receipt.nativeOutcome === 'unknown'
  const recoverable = matches && receipt?.state === 'recovery_required'
  const abandoned = matches && receipt?.state === 'abandoned'
  const acceptedDate = new Date(receipt?.acceptedAt ?? Number.NaN)
  const acceptedAt = Number.isFinite(acceptedDate.getTime()) ? acceptedDate.toISOString() : null
  const submit = async () => {
    if (lock.current || !receipt || (!recoverable && !abandoned)) return
    lock.current = true
    setBusy(true)
    setError(null)
    let resolved = abandoned
    try {
      if (!abandoned) {
        const binding = JSON.stringify([receipt.commandFingerprint, receipt.native])
        if (resolution.current?.binding !== binding) {
          resolution.current = { binding, requestId: crypto.randomUUID() }
        }
        const result = await commands.resolve(deviceId, {
          ...target,
          expectedFingerprint: receipt.commandFingerprint,
          expectedNative: receipt.native,
          decision: 'abandon',
          requestId: resolution.current.requestId,
        })
        if (
          result.state !== 'abandoned' ||
          result.taskId !== target.taskId ||
          result.commandId !== target.commandId ||
          result.commandFingerprint !== receipt.commandFingerprint ||
          JSON.stringify(result.native) !== JSON.stringify(receipt.native) ||
          result.nativeOutcome !== 'unknown'
        ) {
          setReceipt(null)
          setError(t('runtimeCommandRecovery.changed'))
          return
        }
        setReceipt(result)
        resolved = true
      }
      await onContinue()
      setContinued(true)
    } catch (cause) {
      if (resolved) {
        setError(t('runtimeCommandRecovery.continue_failed'))
      } else {
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
        setReceipt(null)
        setError(
          t(
            code === 'command_resolution_conflict'
              ? 'runtimeCommandRecovery.changed'
              : code === 'command_resolution_active'
                ? 'runtimeCommandRecovery.active'
                : code === 'permission_denied'
                  ? 'runtimeCommandRecovery.denied'
                  : code === 'command_resolution_unavailable'
                    ? 'runtimeCommandRecovery.unavailable'
                    : 'runtimeCommandRecovery.resolve_failed'
          )
        )
      }
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={loading || busy}
      className="w-full space-y-3 border-t border-border pt-3"
      data-testid="runtime-command-recovery-review"
    >
      <h3 ref={titleRef} tabIndex={-1} id={titleId} className="font-medium text-text-primary">
        {t('runtimeCommandRecovery.title')}
      </h3>
      {loading ? (
        <p role="status">{t('runtimeCommandRecovery.loading')}</p>
      ) : (
        <>
          {receipt && (
            <p
              className="break-words text-text-primary"
              data-testid="runtime-command-recovery-task"
            >
              {receipt.taskTitle && receipt.taskTitle !== receipt.taskId
                ? receipt.taskTitle
                : t('runtimeCommandRecovery.untitled')}
            </p>
          )}
          {acceptedAt && (
            <p className="text-text-secondary" data-testid="runtime-command-recovery-accepted-at">
              {t('runtimeCommandRecovery.accepted_at')}{' '}
              <time dateTime={acceptedAt}>{formatIssueTimestamp(acceptedAt)}</time>
            </p>
          )}
          <p className="leading-relaxed text-text-secondary" role="status">
            {t(
              continued
                ? 'runtimeCommandRecovery.continued'
                : abandoned
                  ? 'runtimeCommandRecovery.abandoned'
                  : recoverable
                    ? 'runtimeCommandRecovery.unknown'
                    : 'runtimeCommandRecovery.changed'
            )}
          </p>
          {(recoverable || abandoned) && !continued && (
            <p className="leading-relaxed text-text-secondary">
              {t('runtimeCommandRecovery.consequences')}
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 md:min-h-8"
          data-testid="runtime-command-recovery-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {t(continued ? 'runtimeCommandRecovery.close' : 'runtimeCommandRecovery.cancel')}
        </Button>
        {!loading && !continued && !recoverable && !abandoned && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid="runtime-command-recovery-refresh"
            disabled={busy}
            onClick={() => {
              setLoading(true)
              setReceipt(null)
              setError(null)
              setRevision(value => value + 1)
            }}
          >
            {t('runtimeCommandRecovery.review_again')}
          </Button>
        )}
        {!loading && !continued && (recoverable || abandoned) && (
          <Button
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid="runtime-command-recovery-confirm"
            disabled={busy}
            onClick={() => void submit()}
          >
            {t(
              busy
                ? 'runtimeCommandRecovery.working'
                : abandoned
                  ? 'runtimeCommandRecovery.continue'
                  : 'runtimeCommandRecovery.confirm'
            )}
          </Button>
        )}
      </div>
    </section>
  )
}
