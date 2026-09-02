// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
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
import type { CodeWikiAutomaticUpdate } from '@/types/code-wiki'
import type { SearchUser } from '@/types/api'

interface Props {
  knowledgeBaseId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (plan: CodeWikiAutomaticUpdate) => void
}

export function AutomaticUpdateDialog({ knowledgeBaseId, open, onOpenChange, onSaved }: Props) {
  const { t } = useTranslation('knowledge')
  const [plan, setPlan] = useState<CodeWikiAutomaticUpdate | null>(null)
  const [selectedRunners, setSelectedRunners] = useState<SearchUser[]>([])
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadPlan = useCallback(async () => {
    setLoadError(null)
    try {
      const value = await codeWikiApi.automaticUpdate(knowledgeBaseId)
      setPlan(
        value.configured
          ? value
          : { ...value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      )
      setSelectedRunners([])
      if (value.execution_principal_user_id) {
        try {
          const response = await userApis.getUsersByIds([value.execution_principal_user_id])
          setSelectedRunners(response.users)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      }
    } catch (error) {
      setPlan(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [knowledgeBaseId])

  useEffect(() => {
    if (open) void loadPlan()
  }, [loadPlan, open])

  const save = async () => {
    if (!plan) return
    if (
      plan.cadence === 'custom' &&
      (!Number.isInteger(plan.interval_days) || plan.interval_days < 2 || plan.interval_days > 365)
    ) {
      toast.error(t('codeWiki.automatic.invalidCustomDays'))
      return
    }
    setSaving(true)
    try {
      const saved = await codeWikiApi.configureAutomaticUpdate(knowledgeBaseId, {
        enabled: plan.enabled,
        cadence: plan.cadence,
        interval_days: plan.interval_days,
        weekday: plan.weekday,
        hour: plan.hour,
        minute: plan.minute,
        timezone: plan.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        execution_principal_user_id: selectedRunners[0]?.id ?? null,
      })
      setPlan(saved)
      onSaved(saved)
      onOpenChange(false)
      toast.success(t('codeWiki.automatic.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="code-wiki-automatic-update-dialog">
        <DialogHeader>
          <DialogTitle>{t('codeWiki.automatic.title')}</DialogTitle>
          <DialogDescription>{t('codeWiki.automatic.description')}</DialogDescription>
        </DialogHeader>
        {plan && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="code-wiki-auto-enabled">{t('codeWiki.automatic.enabled')}</Label>
              <Switch
                id="code-wiki-auto-enabled"
                data-testid="code-wiki-auto-enabled"
                checked={plan.enabled}
                onCheckedChange={enabled => setPlan(current => current && { ...current, enabled })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('codeWiki.automatic.cadence')}</Label>
              <Select
                value={plan.cadence}
                onValueChange={value => {
                  const cadence = value as CodeWikiAutomaticUpdate['cadence']
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
                <SelectTrigger data-testid="code-wiki-auto-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">{t('codeWiki.automatic.daily')}</SelectItem>
                  <SelectItem value="weekly">{t('codeWiki.automatic.weekly')}</SelectItem>
                  <SelectItem value="biweekly">{t('codeWiki.automatic.biweekly')}</SelectItem>
                  <SelectItem value="four_weeks">{t('codeWiki.automatic.four_weeks')}</SelectItem>
                  <SelectItem value="custom">{t('codeWiki.automatic.custom')}</SelectItem>
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
                  aria-label={t('codeWiki.automatic.customDays')}
                  data-testid="code-wiki-auto-custom-days"
                />
              )}
            </div>
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t('codeWiki.automatic.advanced')}
              </summary>
              <div className="mt-3 space-y-2">
                <Label>{t('codeWiki.automatic.runner')}</Label>
                <p className="text-xs text-text-secondary">{t('codeWiki.automatic.runnerHint')}</p>
                <UserSearchSelect
                  selectedUsers={selectedRunners}
                  onSelectedUsersChange={setSelectedRunners}
                  multiple={false}
                  placeholder={t('codeWiki.automatic.runnerPlaceholder')}
                />
              </div>
            </details>
            <div className="grid grid-cols-2 gap-3">
              {['weekly', 'biweekly', 'four_weeks'].includes(plan.cadence) && (
                <div className="space-y-2">
                  <Label>{t('codeWiki.automatic.weekday')}</Label>
                  <Select
                    value={String(plan.weekday)}
                    onValueChange={value =>
                      setPlan(current => current && { ...current, weekday: Number(value) })
                    }
                  >
                    <SelectTrigger data-testid="code-wiki-auto-weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map(day => (
                        <SelectItem key={day} value={String(day)}>
                          {t(`codeWiki.automatic.weekdays.${day}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="code-wiki-auto-time">{t('codeWiki.automatic.time')}</Label>
                <Input
                  id="code-wiki-auto-time"
                  type="time"
                  value={`${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`}
                  onChange={event => {
                    const [hour, minute] = event.target.value.split(':').map(Number)
                    setPlan(current => current && { ...current, hour, minute })
                  }}
                  data-testid="code-wiki-auto-time"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-wiki-auto-timezone">{t('codeWiki.automatic.timezone')}</Label>
              <Input
                id="code-wiki-auto-timezone"
                value={plan.timezone}
                onChange={event =>
                  setPlan(current => current && { ...current, timezone: event.target.value })
                }
                placeholder="Asia/Shanghai"
                data-testid="code-wiki-auto-timezone"
              />
            </div>
            <p className="text-xs text-text-secondary">
              {t('codeWiki.automatic.next', {
                when: plan.next_execution_time
                  ? new Date(plan.next_execution_time).toLocaleString()
                  : t('codeWiki.automatic.afterSave'),
              })}
            </p>
            {plan.executions[0]?.status === 'FAILED' && (
              <p className="text-sm text-destructive" data-testid="code-wiki-auto-last-error">
                {plan.executions[0].error_message}
              </p>
            )}
            {plan.executions.length > 0 && (
              <div className="space-y-2">
                <Label>{t('codeWiki.automatic.history')}</Label>
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border px-3">
                  {plan.executions.map(execution => (
                    <li key={execution.id} className="py-2 text-xs">
                      <div className="flex justify-between gap-3">
                        <span>{execution.status}</span>
                        <span className="text-text-tertiary">
                          {new Date(execution.created_at).toLocaleString()}
                        </span>
                      </div>
                      {(execution.error_message || execution.result_summary) && (
                        <p className="mt-1 break-words text-text-secondary">
                          {execution.error_message || execution.result_summary}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {loadError && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-destructive" role="alert">
              {loadError}
            </p>
            <Button
              variant="outline"
              onClick={() => void loadPlan()}
              data-testid="code-wiki-auto-retry"
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="code-wiki-auto-cancel"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={!plan || saving}
            data-testid="code-wiki-auto-save"
          >
            {saving ? t('codeWiki.automatic.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
