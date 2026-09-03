// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileJson2,
  FolderTree,
  GitMerge,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'

import {
  adminPluginPublicationApis,
  type AdminPluginPublicationRequestDetail,
} from '@/apis/admin-plugin-publications'
import { ApiError } from '@/apis/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tag } from '@/components/ui/tag'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { formatUTC8DateTime } from '@/lib/utils'
import {
  PluginPublicationCheckTags,
  PluginPublicationRiskTag,
  PluginPublicationStageProgress,
  PluginPublicationStatusTag,
} from './PluginPublicationStatus'

interface PluginPublicationReviewDrawerProps {
  requestId: number | null
  onOpenChange: (open: boolean) => void
  onRequestUpdated: (detail: AdminPluginPublicationRequestDetail) => void
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function parseRequiredChanges(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean)
    )
  )
}

const CHECK_TITLE_KEYS: Record<string, string> = {
  'package.archive_safety':
    'marketplace_management.plugin_publications.checks.codes.package_archive_safety',
  'package.manifest_contract':
    'marketplace_management.plugin_publications.checks.codes.package_manifest_contract',
  'evidence.test_notes':
    'marketplace_management.plugin_publications.checks.codes.evidence_test_notes',
  'compatibility.windows_native':
    'marketplace_management.plugin_publications.checks.codes.compatibility_windows_native',
  'compatibility.macos_native':
    'marketplace_management.plugin_publications.checks.codes.compatibility_macos_native',
  'risk.command_declaration':
    'marketplace_management.plugin_publications.checks.codes.risk_command_declaration',
  'risk.external_network':
    'marketplace_management.plugin_publications.checks.codes.risk_external_network',
  'risk.local_files': 'marketplace_management.plugin_publications.checks.codes.risk_local_files',
  'risk.credentials': 'marketplace_management.plugin_publications.checks.codes.risk_credentials',
  'risk.application_permissions':
    'marketplace_management.plugin_publications.checks.codes.risk_application_permissions',
}

const EVENT_MESSAGE_KEYS: Record<string, string> = {
  'request.created': 'marketplace_management.plugin_publications.events.request_created',
  'revision.created': 'marketplace_management.plugin_publications.events.revision_created',
  'revision.submitted': 'marketplace_management.plugin_publications.events.revision_submitted',
  'automatic_checks.completed':
    'marketplace_management.plugin_publications.events.automatic_checks_completed',
  'automatic_checks.failed':
    'marketplace_management.plugin_publications.events.automatic_checks_failed',
  'request.withdrawn': 'marketplace_management.plugin_publications.events.request_withdrawn',
  'admin.changes_requested':
    'marketplace_management.plugin_publications.events.admin_changes_requested',
  'admin.accepted': 'marketplace_management.plugin_publications.events.admin_accepted',
  'gitlab.reconciled': 'marketplace_management.plugin_publications.events.gitlab_reconciled',
  'gitlab.materialization_failed':
    'marketplace_management.plugin_publications.events.gitlab_materialization_failed',
  'gitlab.materialization_ignored':
    'marketplace_management.plugin_publications.events.gitlab_materialization_ignored',
  'gitlab.draft_mr_created':
    'marketplace_management.plugin_publications.events.gitlab_draft_mr_created',
  'gitlab.event_received':
    'marketplace_management.plugin_publications.events.gitlab_event_received',
  'gitlab.event_ignored': 'marketplace_management.plugin_publications.events.gitlab_event_ignored',
  'gitlab.pipeline_failed':
    'marketplace_management.plugin_publications.events.gitlab_pipeline_failed',
  'gitlab.merge_request_closed':
    'marketplace_management.plugin_publications.events.gitlab_merge_request_closed',
  'release.published': 'marketplace_management.plugin_publications.events.release_published',
  'release.failed': 'marketplace_management.plugin_publications.events.release_failed',
}

function createOperationAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd
        className={
          mono ? 'break-all font-mono text-xs text-text-primary' : 'text-sm text-text-primary'
        }
      >
        {value}
      </dd>
    </div>
  )
}

export default function PluginPublicationReviewDrawer({
  requestId,
  onOpenChange,
  onRequestUpdated,
}: PluginPublicationReviewDrawerProps) {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const loadSequenceRef = useRef(0)
  const reconcileAttemptIdRef = useRef<string | null>(null)
  const [detail, setDetail] = useState<AdminPluginPublicationRequestDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [concurrentUpdate, setConcurrentUpdate] = useState(false)
  const [action, setAction] = useState<'return' | 'accept' | 'reconcile' | null>(null)
  const [returnDialogOpen, setReturnDialogOpen] = useState(false)
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false)
  const [returnReason, setReturnReason] = useState('')
  const [requiredChangesDraft, setRequiredChangesDraft] = useState('')
  const [selectedReturnCheckCodes, setSelectedReturnCheckCodes] = useState<Set<string>>(
    () => new Set()
  )
  const [acknowledgedWarningCodes, setAcknowledgedWarningCodes] = useState<Set<string>>(
    () => new Set()
  )

  const localizedCheckTitle = useCallback(
    (check: { checkCode: string; title?: string | null }) => {
      const key = CHECK_TITLE_KEYS[check.checkCode]
      return key ? t(key) : check.title || check.checkCode
    },
    [t]
  )
  const localizedCheckSummary = useCallback(
    (status: string) => t(`marketplace_management.plugin_publications.checks.summaries.${status}`),
    [t]
  )
  const localizedEventMessage = useCallback(
    (event: AdminPluginPublicationRequestDetail['events'][number]) => {
      if (event.eventType === 'gitlab.merge_request_closed') {
        return event.actorName
          ? t('marketplace_management.plugin_publications.events.gitlab_merge_request_closed_by', {
              actor: event.actorName,
            })
          : t('marketplace_management.plugin_publications.events.gitlab_merge_request_closed')
      }
      const key = EVENT_MESSAGE_KEYS[event.eventType]
      const label = key ? t(key) : event.message || event.eventType
      return event.eventType === 'admin.changes_requested' && event.message
        ? `${label}: ${event.message}`
        : label
    },
    [t]
  )
  const localizedFailureReason = useCallback(
    (reason?: string | null, status?: string) => {
      const value = reason || status || 'failed'
      return t(
        `marketplace_management.plugin_publications.pipeline_failure_reasons.${value.replace(/\./g, '_')}`,
        value
      )
    },
    [t]
  )

  const requiredWarningCodes = useMemo(
    () =>
      detail?.checks.filter(check => check.acknowledgementRequired).map(check => check.checkCode) ??
      [],
    [detail]
  )
  const allWarningsAcknowledged = requiredWarningCodes.every(code =>
    acknowledgedWarningCodes.has(code)
  )
  const returnCheckOptions = useMemo(
    () => detail?.checks.filter(check => ['blocked', 'failed'].includes(check.status)) ?? [],
    [detail]
  )
  const requiredChanges = useMemo(
    () =>
      Array.from(
        new Set([
          ...returnCheckOptions
            .filter(check => selectedReturnCheckCodes.has(check.checkCode))
            .map(check => `${localizedCheckTitle(check)} (${check.checkCode})`),
          ...parseRequiredChanges(requiredChangesDraft),
        ])
      ),
    [localizedCheckTitle, requiredChangesDraft, returnCheckOptions, selectedReturnCheckCodes]
  )
  const returnValid = returnReason.trim().length > 0 && requiredChanges.length > 0
  const acceptEnabled =
    Boolean(detail?.actionEligibility.canAccept) &&
    detail?.revision.number === detail?.currentRevision &&
    allWarningsAcknowledged &&
    action === null

  const manifest = detail?.revision.manifest ?? null
  const packageEntries = detail?.revision.packageEntries ?? []
  const capabilities = detail?.revision.capabilities ?? []
  const viewingCurrentRevision = detail?.revision.number === detail?.currentRevision
  const targetRepository = detail?.gitlab?.projectUrl || 'weibo_rd/common/wecode/wework-plugins'
  const targetDirectory = `plugins/${detail?.pluginSlug ?? ''}`
  const selectedBlockerCount =
    detail?.checks.filter(
      check => check.severity === 'blocker' && ['blocked', 'failed'].includes(check.status)
    ).length ?? 0
  const selectedWarningCount =
    detail?.checks.filter(check => check.status === 'warning').length ?? 0
  const displayedBlockerCount = viewingCurrentRevision
    ? (detail?.blockerCount ?? 0)
    : selectedBlockerCount
  const displayedWarningCount = viewingCurrentRevision
    ? (detail?.warningCount ?? 0)
    : selectedWarningCount

  const applyDetail = useCallback((nextDetail: AdminPluginPublicationRequestDetail) => {
    setDetail(nextDetail)
    setAcknowledgedWarningCodes(
      new Set(
        nextDetail.checks
          .filter(check => check.acknowledgementRequired && check.acknowledged)
          .map(check => check.checkCode)
      )
    )
  }, [])

  const loadDetail = useCallback(
    async (signal?: AbortSignal, revision?: number) => {
      if (requestId === null) return
      const sequence = loadSequenceRef.current + 1
      loadSequenceRef.current = sequence
      if (revision === undefined) {
        setLoading(true)
        setLoadFailed(false)
      } else {
        setRevisionLoading(true)
      }
      try {
        const nextDetail = await adminPluginPublicationApis.getPublicationRequest(
          requestId,
          signal,
          revision
        )
        if (sequence !== loadSequenceRef.current) return
        applyDetail(nextDetail)
      } catch (error) {
        if (isAbortError(error) || sequence !== loadSequenceRef.current) return
        if (revision === undefined) setLoadFailed(true)
        toast({
          title: t('marketplace_management.plugin_publications.detail.load_failed'),
          variant: 'destructive',
        })
      } finally {
        if (!signal?.aborted && sequence === loadSequenceRef.current) {
          setLoading(false)
          setRevisionLoading(false)
        }
      }
    },
    [applyDetail, requestId, t, toast]
  )

  useEffect(() => {
    if (requestId === null) {
      loadSequenceRef.current += 1
      setDetail(null)
      setLoadFailed(false)
      setConcurrentUpdate(false)
      return
    }
    setConcurrentUpdate(false)
    const controller = new AbortController()
    void loadDetail(controller.signal)
    return () => {
      controller.abort()
      loadSequenceRef.current += 1
    }
  }, [loadDetail, requestId])

  useEffect(() => {
    reconcileAttemptIdRef.current = null
  }, [detail?.currentRevision, requestId])

  const handleActionError = useCallback(
    async (error: unknown) => {
      const conflict = error instanceof ApiError && error.status === 409
      toast({
        title: conflict
          ? t('marketplace_management.plugin_publications.actions.revision_conflict')
          : t('marketplace_management.plugin_publications.actions.failed'),
        variant: 'destructive',
      })
      if (conflict) {
        await loadDetail()
        setConcurrentUpdate(true)
      }
    },
    [loadDetail, t, toast]
  )

  const handleReturn = async () => {
    if (!detail || !returnValid) return
    setAction('return')
    try {
      const updated = await adminPluginPublicationApis.returnPublicationRequest(detail.id, {
        currentRevision: detail.currentRevision,
        reason: returnReason.trim(),
        requiredChanges,
      })
      applyDetail(updated)
      onRequestUpdated(updated)
      setReturnDialogOpen(false)
      setReturnReason('')
      setRequiredChangesDraft('')
      setSelectedReturnCheckCodes(new Set())
      toast({ title: t('marketplace_management.plugin_publications.actions.returned') })
    } catch (error) {
      await handleActionError(error)
    } finally {
      setAction(null)
    }
  }

  const openReturnDialog = () => {
    setSelectedReturnCheckCodes(new Set(returnCheckOptions.map(check => check.checkCode)))
    setReturnDialogOpen(true)
  }

  const toggleReturnCheck = (checkCode: string, checked: boolean) => {
    setSelectedReturnCheckCodes(previous => {
      const next = new Set(previous)
      if (checked) next.add(checkCode)
      else next.delete(checkCode)
      return next
    })
  }

  const handleAccept = async () => {
    if (!detail || !acceptEnabled) return
    setAction('accept')
    try {
      const updated = await adminPluginPublicationApis.acceptPublicationRequest(detail.id, {
        currentRevision: detail.currentRevision,
        acknowledgedWarningCodes: requiredWarningCodes.filter(code =>
          acknowledgedWarningCodes.has(code)
        ),
      })
      applyDetail(updated)
      onRequestUpdated(updated)
      setAcceptDialogOpen(false)
      toast({ title: t('marketplace_management.plugin_publications.actions.accepted') })
    } catch (error) {
      await handleActionError(error)
    } finally {
      setAction(null)
    }
  }

  const handleReconcile = async () => {
    if (!detail || !detail.actionEligibility.canReconcile || action !== null) return
    const operationAttemptId =
      reconcileAttemptIdRef.current ?? (reconcileAttemptIdRef.current = createOperationAttemptId())
    setAction('reconcile')
    try {
      const updated = await adminPluginPublicationApis.reconcilePublicationRequest(
        detail.id,
        {
          currentRevision: detail.currentRevision,
        },
        operationAttemptId
      )
      reconcileAttemptIdRef.current = null
      applyDetail(updated)
      onRequestUpdated(updated)
      toast({ title: t('marketplace_management.plugin_publications.actions.reconciled') })
    } catch (error) {
      await handleActionError(error)
    } finally {
      setAction(null)
    }
  }

  const toggleWarningAcknowledgement = (checkCode: string, checked: boolean) => {
    setAcknowledgedWarningCodes(previous => {
      const next = new Set(previous)
      if (checked) next.add(checkCode)
      else next.delete(checkCode)
      return next
    })
  }

  const handleRevisionChange = async (revision: number) => {
    if (!detail || detail.revision.number === revision || revisionLoading) return
    await loadDetail(undefined, revision)
  }

  return (
    <>
      <Drawer open={requestId !== null} onOpenChange={onOpenChange}>
        <DrawerContent
          className="ml-auto h-screen w-full max-w-[860px] rounded-none bg-base"
          showHandle={false}
          data-testid="plugin-publication-detail-drawer"
        >
          <DrawerHeader className="flex-row items-start justify-between gap-4 border-b border-border px-5 py-4 text-left">
            <div className="min-w-0">
              <DrawerTitle className="truncate">
                {detail?.pluginName ?? t('marketplace_management.plugin_publications.detail.title')}
              </DrawerTitle>
              <DrawerDescription className="mt-1">
                {detail
                  ? t('marketplace_management.plugin_publications.detail.subtitle', {
                      id: detail.id,
                      revision: detail.revision.number,
                    })
                  : t('marketplace_management.plugin_publications.detail.loading')}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label={t('marketplace_management.plugin_publications.detail.close')}
                data-testid="plugin-publication-detail-close"
              >
                <X className="h-5 w-5" aria-hidden />
              </Button>
            </DrawerClose>
          </DrawerHeader>

          {loading ? (
            <div
              className="flex flex-1 items-center justify-center"
              data-testid="plugin-publication-detail-loading"
            >
              <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden />
            </div>
          ) : loadFailed || !detail ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <AlertTriangle className="h-10 w-10 text-error" aria-hidden />
              <p className="text-sm text-text-muted">
                {t('marketplace_management.plugin_publications.detail.load_failed')}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadDetail()}
                data-testid="plugin-publication-detail-retry"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t('marketplace_management.plugin_publications.actions.retry')}
              </Button>
            </div>
          ) : (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <div className="grid gap-5 p-5 lg:grid-cols-2">
                  <Card className="space-y-4 p-4 lg:col-span-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <PluginPublicationStatusTag
                        status={viewingCurrentRevision ? detail.status : detail.revision.status}
                      />
                      {viewingCurrentRevision ? (
                        <PluginPublicationRiskTag riskLevel={detail.riskLevel} />
                      ) : null}
                      {displayedBlockerCount > 0 ? (
                        <Tag variant="error">
                          {t('marketplace_management.plugin_publications.blocker_count', {
                            count: displayedBlockerCount,
                          })}
                        </Tag>
                      ) : null}
                      {displayedWarningCount > 0 ? (
                        <Tag variant="warning">
                          {t('marketplace_management.plugin_publications.warning_count', {
                            count: displayedWarningCount,
                          })}
                        </Tag>
                      ) : null}
                    </div>
                    {viewingCurrentRevision ? (
                      <PluginPublicationStageProgress stage={detail.stage} status={detail.status} />
                    ) : null}
                  </Card>

                  {detail.actionEligibility.blockedReasons.length > 0 ? (
                    <Alert variant="warning" className="lg:col-span-2">
                      <AlertTriangle className="h-4 w-4" aria-hidden />
                      <AlertTitle>
                        {t('marketplace_management.plugin_publications.detail.action_blocked')}
                      </AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc space-y-1 pl-5">
                          {detail.actionEligibility.blockedReasons.map(reason => (
                            <li key={reason}>
                              {localizedCheckTitle({ checkCode: reason, title: reason })}
                            </li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {concurrentUpdate ? (
                    <Alert
                      variant="warning"
                      className="lg:col-span-2"
                      data-testid="plugin-publication-concurrent-update"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      <AlertTitle>
                        {t(
                          'marketplace_management.plugin_publications.detail.concurrent_update_title'
                        )}
                      </AlertTitle>
                      <AlertDescription>
                        {t('marketplace_management.plugin_publications.detail.concurrent_update')}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {!viewingCurrentRevision ? (
                    <Alert
                      className="lg:col-span-2"
                      data-testid="plugin-publication-historical-revision-notice"
                    >
                      <History className="h-4 w-4" aria-hidden />
                      <AlertTitle>
                        {t(
                          'marketplace_management.plugin_publications.detail.historical_revision_title'
                        )}
                      </AlertTitle>
                      <AlertDescription>
                        {t('marketplace_management.plugin_publications.detail.historical_revision')}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  <Card className="space-y-4 p-4">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.snapshot')}
                    </h3>
                    <dl className="space-y-3">
                      <DetailField
                        label={t('marketplace_management.plugin_publications.fields.version')}
                        value={detail.revision.requestedVersion}
                      />
                      <DetailField
                        label={t('marketplace_management.plugin_publications.fields.revision')}
                        value={String(detail.revision.number)}
                      />
                      <DetailField
                        label={t('marketplace_management.plugin_publications.fields.sha256')}
                        value={detail.revision.snapshotSha256}
                        mono
                      />
                      <DetailField
                        label={t('marketplace_management.plugin_publications.fields.submitter')}
                        value={detail.submitter.userName}
                      />
                      <DetailField
                        label={t('marketplace_management.plugin_publications.fields.submitted_at')}
                        value={formatUTC8DateTime(detail.submittedAt)}
                      />
                    </dl>
                    {detail.revision.releaseNotes ? (
                      <div className="border-t border-border pt-3">
                        <p className="text-sm font-medium text-text-primary">
                          {t('marketplace_management.plugin_publications.fields.release_notes')}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">
                          {detail.revision.releaseNotes}
                        </p>
                      </div>
                    ) : null}
                    {detail.revision.testNotes ? (
                      <div className="border-t border-border pt-3">
                        <p className="text-sm font-medium text-text-primary">
                          {t('marketplace_management.plugin_publications.fields.test_notes')}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">
                          {detail.revision.testNotes}
                        </p>
                      </div>
                    ) : null}
                  </Card>

                  <Card className="space-y-3 p-4" data-testid="plugin-publication-revision-history">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.revision_history')}
                    </h3>
                    <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                      {[...detail.revisions]
                        .sort((left, right) => right.number - left.number)
                        .map(revision => (
                          <li key={revision.id}>
                            <button
                              type="button"
                              className="w-full space-y-1 px-3 py-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-wait disabled:opacity-70 data-[current=true]:bg-primary/10"
                              onClick={() => void handleRevisionChange(revision.number)}
                              disabled={revisionLoading}
                              aria-current={
                                detail.revision.number === revision.number ? 'true' : undefined
                              }
                              data-current={detail.revision.number === revision.number}
                              data-testid={`plugin-publication-revision-${revision.number}`}
                            >
                              <span className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm font-medium text-text-primary">
                                  Revision {revision.number} · v{revision.requestedVersion}
                                </span>
                                <PluginPublicationStatusTag status={revision.status} />
                              </span>
                              <span className="block break-all font-mono text-xs text-text-muted">
                                {revision.snapshotSha256}
                              </span>
                            </button>
                          </li>
                        ))}
                    </ol>
                    {revisionLoading ? (
                      <p className="flex items-center gap-2 text-xs text-text-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        {t('marketplace_management.plugin_publications.detail.loading_revision')}
                      </p>
                    ) : null}
                  </Card>

                  <Card className="space-y-4 p-4" data-testid="plugin-publication-package">
                    <div className="flex items-center gap-2">
                      <FileJson2 className="h-4 w-4 text-text-muted" aria-hidden />
                      <h3 className="font-semibold text-text-primary">
                        {t('marketplace_management.plugin_publications.detail.manifest')}
                      </h3>
                    </div>
                    {manifest ? (
                      <pre
                        className="max-h-64 overflow-auto rounded-lg border border-border bg-base p-3 font-mono text-xs leading-5 text-text-secondary"
                        data-testid="plugin-publication-manifest"
                      >
                        {JSON.stringify(manifest, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-sm text-text-muted">
                        {t('marketplace_management.plugin_publications.detail.no_manifest')}
                      </p>
                    )}

                    <div className="border-t border-border pt-4">
                      <div className="mb-2 flex items-center gap-2">
                        <FolderTree className="h-4 w-4 text-text-muted" aria-hidden />
                        <h4 className="text-sm font-semibold text-text-primary">
                          {t('marketplace_management.plugin_publications.detail.package_entries')}
                        </h4>
                      </div>
                      {packageEntries.length > 0 ? (
                        <div className="space-y-2">
                          <ul
                            className="max-h-48 space-y-1 overflow-auto rounded-lg border border-border bg-base p-3 font-mono text-xs text-text-secondary"
                            data-testid="plugin-publication-package-entries"
                          >
                            {packageEntries.map(entry => (
                              <li key={entry} className="break-all">
                                {entry}
                              </li>
                            ))}
                          </ul>
                          {detail.revision.packageEntriesTruncated ? (
                            <p className="text-xs text-text-muted">
                              {t(
                                'marketplace_management.plugin_publications.detail.package_entries_truncated',
                                {
                                  count: detail.revision.packageEntryCount,
                                }
                              )}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">
                          {t(
                            'marketplace_management.plugin_publications.detail.no_package_entries'
                          )}
                        </p>
                      )}
                    </div>

                    <div className="border-t border-border pt-4">
                      <div className="mb-2 flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-text-muted" aria-hidden />
                        <h4 className="text-sm font-semibold text-text-primary">
                          {t('marketplace_management.plugin_publications.detail.capabilities')}
                        </h4>
                      </div>
                      {capabilities.length > 0 ? (
                        <div
                          className="flex flex-wrap gap-2"
                          data-testid="plugin-publication-capabilities"
                        >
                          {capabilities.map((capability, index) => (
                            <Tag key={`${capability}-${index}`} variant="info">
                              {capability}
                            </Tag>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">
                          {t('marketplace_management.plugin_publications.detail.no_capabilities')}
                        </p>
                      )}
                    </div>
                  </Card>

                  <Card className="space-y-3 p-4">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.declarations')}
                    </h3>
                    {detail.revision.declarations.length === 0 ? (
                      <p className="text-sm text-text-muted">
                        {t('marketplace_management.plugin_publications.detail.no_declarations')}
                      </p>
                    ) : (
                      <div className="divide-y divide-border">
                        {detail.revision.declarations.map(declaration => (
                          <div
                            key={declaration.key}
                            className="space-y-2 py-3 first:pt-0 last:pb-0"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium text-text-primary">
                                {declaration.label}
                              </span>
                              <div className="flex flex-wrap gap-2">
                                <Tag variant={declaration.declared ? 'warning' : 'success'}>
                                  {declaration.declared
                                    ? t('marketplace_management.plugin_publications.values.yes')
                                    : t('marketplace_management.plugin_publications.values.no')}
                                </Tag>
                                {declaration.detected !== undefined &&
                                declaration.detected !== null &&
                                declaration.detected !== declaration.declared ? (
                                  <Tag variant="error">
                                    {t(
                                      'marketplace_management.plugin_publications.detail.declaration_mismatch'
                                    )}
                                  </Tag>
                                ) : null}
                              </div>
                            </div>
                            {declaration.details?.length ? (
                              <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
                                {declaration.details.map(item => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card className="space-y-3 p-4">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.checks')}
                    </h3>
                    {detail.checks.length === 0 ? (
                      <p className="text-sm text-text-muted">
                        {t('marketplace_management.plugin_publications.detail.no_checks')}
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {detail.checks.map(check => (
                          <div
                            key={check.id}
                            className="rounded-lg border border-border bg-base p-3"
                            data-testid={`plugin-publication-check-${check.checkCode}`}
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <p className="font-medium text-text-primary">
                                  {localizedCheckTitle(check)}
                                </p>
                                <p className="mt-0.5 font-mono text-xs text-text-muted">
                                  {check.checkCode}
                                </p>
                              </div>
                              <PluginPublicationCheckTags
                                severity={check.severity}
                                status={check.status}
                              />
                            </div>
                            <p className="mt-3 text-sm text-text-secondary">
                              {localizedCheckSummary(check.status)}
                            </p>
                            {check.evidence.length > 0 ? (
                              <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-text-muted">
                                {check.evidence.map(item => (
                                  <li key={item} className="break-all">
                                    {item}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {check.jobUrl ? (
                              <a
                                href={check.jobUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm text-primary hover:underline"
                                data-testid={`plugin-publication-check-job-${check.checkCode}`}
                              >
                                {t('marketplace_management.plugin_publications.detail.view_job')}
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                              </a>
                            ) : null}
                            {check.acknowledgementRequired ? (
                              <Label
                                htmlFor={`plugin-publication-warning-${check.checkCode}`}
                                className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2"
                              >
                                <Checkbox
                                  id={`plugin-publication-warning-${check.checkCode}`}
                                  checked={acknowledgedWarningCodes.has(check.checkCode)}
                                  onCheckedChange={checked =>
                                    toggleWarningAcknowledgement(check.checkCode, checked === true)
                                  }
                                  disabled={check.acknowledged || action !== null}
                                  data-testid={`plugin-publication-warning-ack-${check.checkCode}`}
                                />
                                <span className="text-sm leading-5">
                                  {t(
                                    'marketplace_management.plugin_publications.detail.acknowledge_warning'
                                  )}
                                </span>
                              </Label>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card className="space-y-3 p-4">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.gitlab')}
                    </h3>
                    {!detail.gitlab ? (
                      <p className="text-sm text-text-muted">
                        {t('marketplace_management.plugin_publications.detail.gitlab_pending')}
                      </p>
                    ) : (
                      <dl className="space-y-3">
                        <DetailField
                          label={t('marketplace_management.plugin_publications.fields.branch')}
                          value={detail.gitlab.sourceBranch || '-'}
                          mono
                        />
                        <DetailField
                          label={t('marketplace_management.plugin_publications.fields.commit')}
                          value={detail.gitlab.commitSha || '-'}
                          mono
                        />
                        <DetailField
                          label={t('marketplace_management.plugin_publications.fields.mr_status')}
                          value={detail.gitlab.mergeRequestStatus || '-'}
                        />
                        <DetailField
                          label={t(
                            'marketplace_management.plugin_publications.fields.pipeline_status'
                          )}
                          value={detail.gitlab.pipelineStatus || '-'}
                        />
                        <div className="flex flex-wrap gap-2 pt-1">
                          {detail.gitlab.mergeRequestUrl ? (
                            <Button asChild variant="outline" size="sm">
                              <a
                                href={detail.gitlab.mergeRequestUrl}
                                target="_blank"
                                rel="noreferrer"
                                data-testid="plugin-publication-gitlab-mr-link"
                              >
                                <GitMerge className="h-4 w-4" aria-hidden />
                                {t('marketplace_management.plugin_publications.detail.open_mr')}
                              </a>
                            </Button>
                          ) : null}
                          {detail.gitlab.pipelineUrl ? (
                            <Button asChild variant="outline" size="sm">
                              <a
                                href={detail.gitlab.pipelineUrl}
                                target="_blank"
                                rel="noreferrer"
                                data-testid="plugin-publication-gitlab-pipeline-link"
                              >
                                <ExternalLink className="h-4 w-4" aria-hidden />
                                {t(
                                  'marketplace_management.plugin_publications.detail.open_pipeline'
                                )}
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </dl>
                    )}
                  </Card>

                  <Card className="space-y-3 p-4 lg:col-span-2">
                    <h3 className="font-semibold text-text-primary">
                      {t('marketplace_management.plugin_publications.detail.timeline')}
                    </h3>
                    {detail.events.length === 0 ? (
                      <p className="text-sm text-text-muted">
                        {t('marketplace_management.plugin_publications.detail.no_events')}
                      </p>
                    ) : (
                      <ol className="space-y-3">
                        {detail.events.map(event => (
                          <li key={event.id} className="relative border-l border-border pl-4">
                            <span className="absolute -left-1 top-1.5 h-2 w-2 rounded-full bg-primary" />
                            <p className="text-sm text-text-primary">
                              {localizedEventMessage(event)}
                            </p>
                            {event.requiredChanges?.length ? (
                              <ul
                                className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary"
                                data-testid={`plugin-publication-event-required-changes-${event.id}`}
                              >
                                {event.requiredChanges.map(item => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            ) : null}
                            {event.failureDetails?.length ? (
                              <ul
                                className="mt-2 space-y-2"
                                data-testid={`plugin-publication-event-failures-${event.id}`}
                              >
                                {event.failureDetails.map((failure, index) => (
                                  <li
                                    key={`${failure.jobName}-${failure.stage || ''}-${index}`}
                                    className="rounded-lg border border-border bg-surface-secondary px-3 py-2"
                                  >
                                    <p className="text-sm font-medium text-text-primary">
                                      {failure.jobName}
                                      {failure.stage ? ` · ${failure.stage}` : ''}
                                    </p>
                                    <p className="mt-1 text-sm text-text-secondary">
                                      {localizedFailureReason(failure.reason, failure.status)}
                                    </p>
                                    {failure.jobUrl ? (
                                      <a
                                        href={failure.jobUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                        data-testid={`plugin-publication-failed-job-${event.id}-${index}`}
                                      >
                                        {t(
                                          'marketplace_management.plugin_publications.detail.open_failed_job'
                                        )}
                                        <ExternalLink className="h-4 w-4" aria-hidden />
                                      </a>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            <p className="mt-1 text-xs text-text-muted">
                              {event.actorName ||
                                t(
                                  `marketplace_management.plugin_publications.actor_types.${event.actorType}`
                                )}{' '}
                              · {formatUTC8DateTime(event.createdAt)}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Card>
                </div>
              </ScrollArea>

              <div className="flex flex-col-reverse gap-2 border-t border-border bg-base p-4 sm:flex-row sm:items-center sm:justify-end">
                {!viewingCurrentRevision ? (
                  <Button
                    type="button"
                    variant="primary"
                    className="h-11"
                    disabled={revisionLoading}
                    onClick={() => void handleRevisionChange(detail.currentRevision)}
                    data-testid="plugin-publication-return-current-revision"
                  >
                    {revisionLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <History className="h-4 w-4" aria-hidden />
                    )}
                    {t(
                      'marketplace_management.plugin_publications.actions.return_current_revision'
                    )}
                  </Button>
                ) : null}
                {viewingCurrentRevision && detail.actionEligibility.canReconcile ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={action !== null}
                    onClick={() => void handleReconcile()}
                    data-testid="plugin-publication-reconcile"
                  >
                    {action === 'reconcile' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw className="h-4 w-4" aria-hidden />
                    )}
                    {t('marketplace_management.plugin_publications.actions.reconcile')}
                  </Button>
                ) : null}
                {viewingCurrentRevision && detail.actionEligibility.canReturn ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={action !== null}
                    onClick={openReturnDialog}
                    data-testid="plugin-publication-return"
                  >
                    {t('marketplace_management.plugin_publications.actions.return')}
                  </Button>
                ) : null}
                {viewingCurrentRevision ? (
                  <Button
                    type="button"
                    variant="primary"
                    className="h-11"
                    disabled={!acceptEnabled}
                    onClick={() => setAcceptDialogOpen(true)}
                    data-testid="plugin-publication-accept"
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    {t('marketplace_management.plugin_publications.actions.accept')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </DrawerContent>
      </Drawer>

      <Dialog open={returnDialogOpen} onOpenChange={setReturnDialogOpen}>
        <DialogContent className="max-w-lg" data-testid="plugin-publication-return-dialog">
          <DialogHeader>
            <DialogTitle>
              {t('marketplace_management.plugin_publications.return_dialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('marketplace_management.plugin_publications.return_dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="plugin-publication-return-reason">
                {t('marketplace_management.plugin_publications.return_dialog.reason')}
              </Label>
              <Textarea
                id="plugin-publication-return-reason"
                value={returnReason}
                onChange={event => setReturnReason(event.target.value)}
                placeholder={t(
                  'marketplace_management.plugin_publications.return_dialog.reason_placeholder'
                )}
                data-testid="plugin-publication-return-reason"
              />
            </div>
            {returnCheckOptions.length > 0 ? (
              <fieldset
                className="space-y-2 rounded-lg border border-border bg-surface p-3"
                data-testid="plugin-publication-return-checks"
              >
                <legend className="px-1 text-sm font-medium text-text-primary">
                  {t('marketplace_management.plugin_publications.return_dialog.failed_checks')}
                </legend>
                {returnCheckOptions.map(check => (
                  <Label
                    key={check.checkCode}
                    htmlFor={`plugin-publication-return-check-${check.checkCode}`}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-primary/5"
                  >
                    <Checkbox
                      id={`plugin-publication-return-check-${check.checkCode}`}
                      checked={selectedReturnCheckCodes.has(check.checkCode)}
                      onCheckedChange={checked =>
                        toggleReturnCheck(check.checkCode, checked === true)
                      }
                      disabled={action !== null}
                      data-testid={`plugin-publication-return-check-${check.checkCode}`}
                    />
                    <span className="min-w-0 text-sm leading-5">
                      <span className="block text-text-primary">{localizedCheckTitle(check)}</span>
                      <span className="block break-all font-mono text-xs text-text-muted">
                        {check.checkCode}
                      </span>
                    </span>
                  </Label>
                ))}
              </fieldset>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="plugin-publication-required-changes">
                {t('marketplace_management.plugin_publications.return_dialog.additional_changes')}
              </Label>
              <Textarea
                id="plugin-publication-required-changes"
                value={requiredChangesDraft}
                onChange={event => setRequiredChangesDraft(event.target.value)}
                placeholder={t(
                  'marketplace_management.plugin_publications.return_dialog.required_changes_placeholder'
                )}
                data-testid="plugin-publication-required-changes"
              />
              <p className="text-xs text-text-muted">
                {t(
                  'marketplace_management.plugin_publications.return_dialog.required_changes_hint'
                )}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReturnDialogOpen(false)}
              disabled={action !== null}
              data-testid="plugin-publication-return-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!returnValid || action !== null}
              onClick={() => void handleReturn()}
              data-testid="plugin-publication-return-confirm"
            >
              {action === 'return' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('marketplace_management.plugin_publications.actions.confirm_return')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <AlertDialogContent data-testid="plugin-publication-accept-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('marketplace_management.plugin_publications.accept_dialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('marketplace_management.plugin_publications.accept_dialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail ? (
            <dl
              className="space-y-2 rounded-lg border border-border bg-surface p-4"
              data-testid="plugin-publication-accept-target"
            >
              <DetailField
                label={t('marketplace_management.plugin_publications.fields.plugin')}
                value={`${detail.pluginName} (v${detail.revision.requestedVersion})`}
              />
              <DetailField
                label={t('marketplace_management.plugin_publications.fields.request_revision')}
                value={`#${detail.id} / Revision ${detail.currentRevision}`}
                mono
              />
              <DetailField
                label={t('marketplace_management.plugin_publications.fields.sha256')}
                value={detail.revision.snapshotSha256}
                mono
              />
              <div data-testid="plugin-publication-accept-target-repository">
                <DetailField
                  label={t('marketplace_management.plugin_publications.fields.target_repository')}
                  value={targetRepository}
                  mono
                />
              </div>
              <div data-testid="plugin-publication-accept-target-directory">
                <DetailField
                  label={t('marketplace_management.plugin_publications.fields.target_directory')}
                  value={targetDirectory}
                  mono
                />
              </div>
            </dl>
          ) : null}
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertDescription>
              {t('marketplace_management.plugin_publications.accept_dialog.not_publish_notice')}
            </AlertDescription>
          </Alert>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={action !== null}
              data-testid="plugin-publication-accept-cancel"
            >
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              disabled={!acceptEnabled}
              onClick={event => {
                event.preventDefault()
                void handleAccept()
              }}
              data-testid="plugin-publication-accept-confirm"
            >
              {action === 'accept' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {t('marketplace_management.plugin_publications.actions.confirm_accept')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
