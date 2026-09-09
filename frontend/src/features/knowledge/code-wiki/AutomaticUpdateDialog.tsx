// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    codeWikiApi
      .automaticUpdate(knowledgeBaseId)
      .then(async value => {
        setPlan(
          value.configured
            ? value
            : { ...value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        )
        setSelectedRunners([])
        if (value.execution_principal_user_id) {
          const response = await userApis.getUsersByIds([value.execution_principal_user_id])
          setSelectedRunners(response.users)
        }
      })
      .catch(error => toast.error(error instanceof Error ? error.message : String(error)))
  }, [knowledgeBaseId, open])

  const save = async () => {
    if (!plan) return
    setSaving(true)
    try {
      const saved = await codeWikiApi.configureAutomaticUpdate(knowledgeBaseId, {
        enabled: plan.enabled,
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
                checked={plan.enabled}
                onCheckedChange={enabled => setPlan(current => current && { ...current, enabled })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('codeWiki.automatic.cadence')}</Label>
              <Select
                value={String(plan.interval_days)}
                onValueChange={value =>
                  setPlan(current => current && { ...current, interval_days: Number(value) })
                }
              >
                <SelectTrigger data-testid="code-wiki-auto-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">{t('codeWiki.automatic.weekly')}</SelectItem>
                  <SelectItem value="14">{t('codeWiki.automatic.biweekly')}</SelectItem>
                  <SelectItem value="28">{t('codeWiki.automatic.monthly')}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={7}
                max={365}
                value={plan.interval_days}
                onChange={event =>
                  setPlan(
                    current => current && { ...current, interval_days: Number(event.target.value) }
                  )
                }
                aria-label={t('codeWiki.automatic.customDays')}
              />
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={save} disabled={!plan || saving}>
            {saving ? t('codeWiki.automatic.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
