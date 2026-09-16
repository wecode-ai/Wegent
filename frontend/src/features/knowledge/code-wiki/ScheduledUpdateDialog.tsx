// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { codeWikiApi } from '@/apis/code-wiki'
import { userApis } from '@/apis/user'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { parseUTCDate } from '@/lib/utils'
import type { CodeWikiScheduledUpdate, CodeWikiScheduledUpdateRequest } from '@/types/code-wiki'
import type { SearchUser } from '@/types/api'

const EXECUTION_STATUS_KEYS: Record<string, string> = {
  PENDING: 'feed:status_pending',
  RUNNING: 'feed:status_running',
  COMPLETED: 'feed:status_completed',
  COMPLETED_SILENT: 'feed:status_completed_silent',
  FAILED: 'feed:status_failed',
  RETRYING: 'feed:status_retrying',
  CANCELLED: 'feed:status_cancelled',
}

const EXECUTION_RESULT_KEYS: Record<string, string> = {
  'repository unchanged since last run': 'codeWiki.scheduledUpdate.results.repositoryUnchanged',
  'Skipped because scheduled update was deleted': 'codeWiki.scheduledUpdate.results.deleted',
  'Skipped because scheduled update was disabled': 'codeWiki.scheduledUpdate.results.disabled',
  'Skipped because another generation is running':
    'codeWiki.scheduledUpdate.results.generationRunning',
  'Code Wiki no longer exists or its reference no longer matches':
    'codeWiki.scheduledUpdate.results.wikiUnavailable',
}

function formatDateTime(value: string, timezone: string, locale: string): string {
  const date = parseUTCDate(value)
  if (!date || Number.isNaN(date.getTime())) return '-'
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: timezone,
    }).format(date)
  } catch {
    return '-'
  }
}

interface Props {
  knowledgeBaseId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** An unapplied change from this editor, retained if the dialog is reopened. */
  draft?: CodeWikiScheduledUpdateRequest | null
  /** The outer knowledge-base form has staged deletion of the saved plan. */
  deleteRequested?: boolean
  onDraftSaved: (plan: CodeWikiScheduledUpdateRequest) => void
  onDeleteRequested: () => void
}

export function ScheduledUpdateDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
  draft,
  deleteRequested = false,
  onDraftSaved,
  onDeleteRequested,
}: Props) {
  const { t, i18n } = useTranslation('knowledge')
  const [plan, setPlan] = useState<CodeWikiScheduledUpdate | null>(null)
  const [selectedRunners, setSelectedRunners] = useState<SearchUser[]>([])
  const [executionPrincipalUserId, setExecutionPrincipalUserId] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadRequestId = useRef(0)

  const localizeResultSummary = (summary: string) => {
    const key = EXECUTION_RESULT_KEYS[summary]
    if (key) return t(key)

    const started = /^(full|incremental) generation started$/.exec(summary)
    if (started) {
      return t('codeWiki.scheduledUpdate.results.generationStarted', {
        mode: t(`codeWiki.history.mode.${started[1]}`),
      })
    }
    return summary
  }

  const loadPlan = useCallback(async () => {
    const requestId = ++loadRequestId.current
    setLoadError(null)
    try {
      const value = await codeWikiApi.scheduledUpdate(knowledgeBaseId)
      if (loadRequestId.current !== requestId) return
      const loadedPlan = value.configured
        ? value
        : { ...value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      setPlan(draft ? { ...loadedPlan, ...draft } : loadedPlan)
      setSelectedRunners([])
      const runnerId = draft ? draft.execution_principal_user_id : value.execution_principal_user_id
      setExecutionPrincipalUserId(runnerId ?? null)
      if (runnerId) {
        try {
          const response = await userApis.getUsersByIds([runnerId])
          if (loadRequestId.current !== requestId) return
          setSelectedRunners(response.users)
        } catch (error) {
          if (loadRequestId.current !== requestId) return
          toast.error(error instanceof Error ? error.message : String(error))
        }
      }
    } catch (error) {
      if (loadRequestId.current !== requestId) return
      setPlan(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [draft, knowledgeBaseId])

  useEffect(() => {
    if (!open) return
    void loadPlan()
    return () => {
      loadRequestId.current += 1
    }
  }, [loadPlan, open])

  const saveDraft = () => {
    if (!plan?.can_configure) return
    if (
      plan.cadence === 'custom' &&
      (!Number.isInteger(plan.interval_days) || plan.interval_days < 2 || plan.interval_days > 365)
    ) {
      toast.error(t('codeWiki.scheduledUpdate.invalidCustomDays'))
      return
    }
    onDraftSaved({
      enabled: plan.enabled,
      cadence: plan.cadence,
      interval_days: plan.interval_days,
      weekday: plan.weekday,
      hour: plan.hour,
      minute: plan.minute,
      timezone: plan.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      execution_principal_user_id: executionPrincipalUserId,
    })
    onOpenChange(false)
  }

  const deletePlan = () => {
    if (!plan?.can_configure) return
    onDeleteRequested()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="code-wiki-scheduled-update-dialog">
        <DialogHeader>
          <DialogTitle>{t('codeWiki.scheduledUpdate.title')}</DialogTitle>
          <DialogDescription>
            {t(
              deleteRequested
                ? 'codeWiki.scheduledUpdate.pendingDeleteDescription'
                : 'codeWiki.scheduledUpdate.draftDescription'
            )}
          </DialogDescription>
        </DialogHeader>
        {plan && (
          <fieldset disabled={!plan.can_configure} className="space-y-4 py-2">
            {!plan.can_configure && (
              <p className="text-sm text-text-muted" data-testid="code-wiki-scheduled-read-only">
                {t('codeWiki.scheduledUpdate.readOnly')}
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="code-wiki-scheduled-enabled">
                {t('codeWiki.scheduledUpdate.enabled')}
              </Label>
              <Switch
                id="code-wiki-scheduled-enabled"
                data-testid="code-wiki-scheduled-enabled"
                checked={plan.enabled}
                onCheckedChange={enabled => setPlan(current => current && { ...current, enabled })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('codeWiki.scheduledUpdate.cadence')}</Label>
              <Select
                value={plan.cadence}
                onValueChange={value => {
                  const cadence = value as CodeWikiScheduledUpdate['cadence']
                  const fixed = { daily: 1, weekly: 7, biweekly: 14, four_weeks: 28 }
                  setPlan(
                    current =>
                      current && {
                        ...current,
                        cadence,
                        interval_days:
                          cadence === 'custom' ? current.interval_days : fixed[cadence],
                      }
                  )
                }}
              >
                <SelectTrigger data-testid="code-wiki-scheduled-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">{t('codeWiki.scheduledUpdate.daily')}</SelectItem>
                  <SelectItem value="weekly">{t('codeWiki.scheduledUpdate.weekly')}</SelectItem>
                  <SelectItem value="biweekly">{t('codeWiki.scheduledUpdate.biweekly')}</SelectItem>
                  <SelectItem value="four_weeks">
                    {t('codeWiki.scheduledUpdate.four_weeks')}
                  </SelectItem>
                  <SelectItem value="custom">{t('codeWiki.scheduledUpdate.custom')}</SelectItem>
                </SelectContent>
              </Select>
              {plan.cadence === 'custom' && (
                <Input
                  type="number"
                  min={2}
                  max={365}
                  value={plan.interval_days}
                  onChange={event =>
                    setPlan(
                      current =>
                        current && { ...current, interval_days: Number(event.target.value) }
                    )
                  }
                  aria-label={t('codeWiki.scheduledUpdate.customDays')}
                  data-testid="code-wiki-scheduled-custom-days"
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {['weekly', 'biweekly', 'four_weeks'].includes(plan.cadence) && (
                <div className="space-y-2">
                  <Label>{t('codeWiki.scheduledUpdate.weekday')}</Label>
                  <Select
                    value={String(plan.weekday)}
                    onValueChange={value =>
                      setPlan(current => current && { ...current, weekday: Number(value) })
                    }
                  >
                    <SelectTrigger data-testid="code-wiki-scheduled-weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map(day => (
                        <SelectItem key={day} value={String(day)}>
                          {t(`codeWiki.scheduledUpdate.weekdays.${day}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="code-wiki-scheduled-time">
                  {t('codeWiki.scheduledUpdate.time')}
                </Label>
                <Input
                  id="code-wiki-scheduled-time"
                  type="time"
                  value={`${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`}
                  onChange={event => {
                    if (!event.target.value) return
                    const [hour, minute] = event.target.value.split(':').map(Number)
                    if (
                      !Number.isInteger(hour) ||
                      !Number.isInteger(minute) ||
                      hour < 0 ||
                      hour > 23 ||
                      minute < 0 ||
                      minute > 59
                    ) {
                      return
                    }
                    setPlan(current => current && { ...current, hour, minute })
                  }}
                  data-testid="code-wiki-scheduled-time"
                />
              </div>
            </div>
            <p className="text-xs text-text-muted" data-testid="code-wiki-scheduled-timezone">
              {t('codeWiki.scheduledUpdate.timezoneHint', { timezone: plan.timezone })}
            </p>
            <p className="text-xs text-text-secondary">
              {t('codeWiki.scheduledUpdate.next', {
                when: plan.next_execution_time
                  ? formatDateTime(plan.next_execution_time, plan.timezone, i18n.language)
                  : t('codeWiki.scheduledUpdate.afterSave'),
              })}
            </p>
            {plan.executions[0]?.status === 'FAILED' && (
              <p className="text-sm text-destructive" data-testid="code-wiki-scheduled-last-error">
                {plan.executions[0].error_message}
              </p>
            )}
            {plan.executions.length > 0 && (
              <div className="space-y-2">
                <Label>{t('codeWiki.scheduledUpdate.history')}</Label>
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border px-3">
                  {plan.executions.map(execution => (
                    <li key={execution.id} className="py-2 text-xs">
                      <div className="flex justify-between gap-3">
                        <span>
                          {EXECUTION_STATUS_KEYS[execution.status]
                            ? t(EXECUTION_STATUS_KEYS[execution.status])
                            : execution.status}
                        </span>
                        <span className="text-text-tertiary">
                          {formatDateTime(execution.created_at, plan.timezone, i18n.language)}
                        </span>
                      </div>
                      {(execution.error_message || execution.result_summary) && (
                        <p className="mt-1 break-words text-text-secondary">
                          {execution.error_message ||
                            localizeResultSummary(execution.result_summary)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <details className="group space-y-3">
              <summary
                className="flex w-full cursor-pointer list-none items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden"
                data-testid="code-wiki-scheduled-advanced"
              >
                <span className="shrink-0 text-sm font-semibold text-text-primary">
                  {t('codeWiki.scheduledUpdate.advanced')}
                </span>
                <span className="h-px flex-1 bg-border transition-colors group-hover:bg-primary/40" />
                <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-text-muted transition-transform duration-200 group-open:rotate-0" />
              </summary>
              <div className="space-y-2">
                <Label>{t('codeWiki.scheduledUpdate.runner')}</Label>
                <p className="text-xs text-text-secondary">
                  {t('codeWiki.scheduledUpdate.runnerHint')}
                </p>
                <UserSearchSelect
                  selectedUsers={selectedRunners}
                  onSelectedUsersChange={users => {
                    setSelectedRunners(users)
                    setExecutionPrincipalUserId(users[0]?.id ?? null)
                  }}
                  multiple={false}
                  placeholder={t('codeWiki.scheduledUpdate.runnerPlaceholder')}
                  inputTestId="code-wiki-scheduled-runner"
                />
              </div>
            </details>
          </fieldset>
        )}
        {loadError && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-destructive" role="alert">
              {loadError}
            </p>
            <Button
              variant="outline"
              onClick={() => void loadPlan()}
              data-testid="code-wiki-scheduled-retry"
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        <DialogFooter>
          {plan?.configured && plan.can_configure && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="mr-auto text-destructive hover:text-destructive"
                  data-testid="code-wiki-scheduled-delete"
                >
                  {t('codeWiki.scheduledUpdate.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent data-testid="code-wiki-scheduled-delete-confirm">
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('codeWiki.scheduledUpdate.deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('codeWiki.scheduledUpdate.deleteDescription')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="code-wiki-scheduled-delete-cancel">
                    {t('common:actions.cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={deletePlan}
                    data-testid="code-wiki-scheduled-delete-action"
                  >
                    {t('codeWiki.scheduledUpdate.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="code-wiki-scheduled-cancel"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={saveDraft}
            disabled={!plan?.can_configure}
            data-testid="code-wiki-scheduled-save"
          >
            {t('codeWiki.scheduledUpdate.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
