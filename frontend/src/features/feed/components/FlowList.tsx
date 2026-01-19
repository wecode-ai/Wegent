'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow configuration list component.
 */
import { useCallback, useState } from 'react'
import {
  CalendarClock,
  Clock,
  Copy,
  Edit,
  Hash,
  Key,
  MoreHorizontal,
  Play,
  Plus,
  Timer,
  Trash2,
  Webhook,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
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
import { useFlowContext } from '../contexts/flowContext'
import { flowApis } from '@/apis/flow'
import type { Flow, FlowTriggerType } from '@/types/flow'
import { toast } from 'sonner'
import { formatUTCDate } from '@/lib/utils'

interface FlowListProps {
  onCreateFlow: () => void
  onEditFlow: (flow: Flow) => void
}

const triggerTypeIcons: Record<FlowTriggerType, React.ReactNode> = {
  cron: <CalendarClock className="h-4 w-4" />,
  interval: <Timer className="h-4 w-4" />,
  one_time: <Clock className="h-4 w-4" />,
  event: <Webhook className="h-4 w-4" />,
}

export function FlowList({ onCreateFlow, onEditFlow }: FlowListProps) {
  const { t } = useTranslation('feed')
  const { flows, flowsLoading, flowsTotal, refreshFlows, loadMoreFlows, refreshExecutions } =
    useFlowContext()

  const [deleteConfirmFlow, setDeleteConfirmFlow] = useState<Flow | null>(null)
  const [actionLoading, setActionLoading] = useState<number | null>(null)

  const handleToggle = useCallback(
    async (flow: Flow, enabled: boolean) => {
      setActionLoading(flow.id)
      try {
        await flowApis.toggleFlow(flow.id, enabled)
        await refreshFlows()
        toast.success(enabled ? t('enabled_success') : t('disabled_success'))
      } catch (error) {
        console.error('Failed to toggle flow:', error)
        toast.error(t('toggle_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [refreshFlows, t]
  )

  const handleTrigger = useCallback(
    async (flow: Flow) => {
      setActionLoading(flow.id)
      try {
        await flowApis.triggerFlow(flow.id)
        toast.success(t('trigger_success'))
        // Refresh executions to show the new execution in timeline
        refreshExecutions()
      } catch (error) {
        console.error('Failed to trigger flow:', error)
        toast.error(t('trigger_failed'))
      } finally {
        setActionLoading(null)
      }
    },
    [t, refreshExecutions]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmFlow) return

    setActionLoading(deleteConfirmFlow.id)
    try {
      await flowApis.deleteFlow(deleteConfirmFlow.id)
      await refreshFlows()
      toast.success(t('delete_success'))
    } catch (error) {
      console.error('Failed to delete flow:', error)
      toast.error(t('delete_failed'))
    } finally {
      setActionLoading(null)
      setDeleteConfirmFlow(null)
    }
  }, [deleteConfirmFlow, refreshFlows, t])

  const handleCopyWebhookUrl = useCallback(
    async (flow: Flow) => {
      if (!flow.webhook_url) return
      try {
        // Construct full URL
        const baseUrl = window.location.origin
        const fullUrl = `${baseUrl}${flow.webhook_url}`
        await navigator.clipboard.writeText(fullUrl)
        toast.success(t('webhook_url_copied'))
      } catch (error) {
        console.error('Failed to copy webhook URL:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const handleCopyWebhooksecret = useCallback(
    async (flow: Flow) => {
      if (!flow.webhook_secret) return
      try {
        await navigator.clipboard.writeText(flow.webhook_secret)
        toast.success(t('webhook_secret_copied'))
      } catch (error) {
        console.error('Failed to copy webhook secret:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const handleCopyFlowId = useCallback(
    async (flow: Flow) => {
      try {
        await navigator.clipboard.writeText(String(flow.id))
        toast.success(t('flow_id_copied'))
      } catch (error) {
        console.error('Failed to copy flow ID:', error)
        toast.error(t('copy_failed'))
      }
    },
    [t]
  )

  const formatNextExecution = (dateStr?: string) => {
    return formatUTCDate(dateStr)
  }

  const getTriggerLabel = (flow: Flow): string => {
    const config = flow.trigger_config || {}
    switch (flow.trigger_type) {
      case 'cron':
        return String(config.expression || 'Cron')
      case 'interval':
        return `${config.value || ''} ${config.unit || ''}`.trim() || 'Interval'
      case 'one_time':
        return t('trigger_one_time')
      case 'event':
        return config.event_type === 'webhook' ? 'Webhook' : 'Git Push'
      default:
        return flow.trigger_type || 'Unknown'
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {flowsLoading && flows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : flows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-text-muted">
            <p>{t('no_flows')}</p>
            <Button variant="outline" onClick={onCreateFlow} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              {t('create_first_flow')}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {flows.map(flow => (
              <div key={flow.id} className="flex items-center gap-4 px-4 py-3 hover:bg-surface/50">
                {/* Icon and Name */}
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    {triggerTypeIcons[flow.trigger_type]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{flow.display_name}</span>
                      <Badge
                        variant={flow.task_type === 'execution' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {flow.task_type === 'execution'
                          ? t('task_type_execution')
                          : t('task_type_collection')}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <span>{getTriggerLabel(flow)}</span>
                      {flow.trigger_type !== 'event' && (
                        <>
                          <span>·</span>
                          <span>
                            {t('next_execution')}: {formatNextExecution(flow.next_execution_time)}
                          </span>
                        </>
                      )}
                      {flow.trigger_type === 'event' && flow.webhook_url && (
                        <>
                          <span>·</span>
                          <span className="truncate max-w-[200px]">{flow.webhook_url}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div className="hidden text-center sm:block">
                  <div className="text-sm font-medium">{flow.execution_count}</div>
                  <div className="text-xs text-text-muted">{t('executions')}</div>
                </div>

                {/* Toggle */}
                <Switch
                  checked={flow.enabled}
                  onCheckedChange={enabled => handleToggle(flow, enabled)}
                  disabled={actionLoading === flow.id}
                />

                {/* Actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleTrigger(flow)}
                      disabled={actionLoading === flow.id}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      {t('trigger_now')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEditFlow(flow)}>
                      <Edit className="mr-2 h-4 w-4" />
                      {t('edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCopyFlowId(flow)}>
                      <Hash className="mr-2 h-4 w-4" />
                      {t('copy_flow_id')}
                    </DropdownMenuItem>
                    {/* Webhook copy options for event triggers */}
                    {flow.trigger_type === 'event' && flow.webhook_url && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleCopyWebhookUrl(flow)}>
                          <Copy className="mr-2 h-4 w-4" />
                          {t('copy_webhook_url')}
                        </DropdownMenuItem>
                        {flow.webhook_secret && (
                          <DropdownMenuItem onClick={() => handleCopyWebhooksecret(flow)}>
                            <Key className="mr-2 h-4 w-4" />
                            {t('copy_webhook_secret')}
                          </DropdownMenuItem>
                        )}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setDeleteConfirmFlow(flow)}
                      className="text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}

            {/* Load more */}
            {flows.length < flowsTotal && (
              <div className="flex justify-center py-4">
                <Button variant="ghost" onClick={loadMoreFlows} disabled={flowsLoading}>
                  {flowsLoading ? t('common:actions.loading') : t('common:tasks.load_more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmFlow}
        onOpenChange={open => !open && setDeleteConfirmFlow(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('delete_confirm_message', {
                name: deleteConfirmFlow?.display_name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
