import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  createCollaborationTranslator,
  IssueDeliveries,
  IssueDeliveryContent,
  IssueLinkedTasks,
  threadStatuses,
  collaborationMessages,
  type SharedIssueDetailDeliveryDetail,
  type SharedIssueDetailTaskBinding,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { TodoPersonalTaskAction } from '@/features/todo/TodoPersonalTaskAction'
import type { ThreadActionContext } from './threadActions'
import { canStartThreadPersonalTask } from './threadPersonalTaskAccess'
import { useThreadWorkRecords } from './useThreadWorkRecords'
import {
  issueTaskExecutionStates,
  runtimeTaskConversationStatusesByAddress,
} from '@/features/todo/runtimeTaskConversationStatus'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

export function ThreadWorkMetadata({
  context,
  locale,
  onCreate,
  onOpen,
  runtimeWork,
  runtimeTaskLifecycle,
  deviceNamesById,
}: {
  context: ThreadActionContext
  locale: 'zh-CN' | 'en'
  onCreate(context: ThreadActionContext): void
  onOpen(context: ThreadActionContext, binding: SharedIssueDetailTaskBinding): void
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  deviceNamesById?: Readonly<Record<string, string>>
}) {
  const { t } = useTranslation('collaboration')
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const records = useThreadWorkRecords(context)
  const taskExecutionStates = useMemo(
    () =>
      issueTaskExecutionStates(
        records.bindings.items.map(binding => ({
          id: binding.id,
          deviceId: binding.device_id,
          taskId: binding.task_id,
        })),
        runtimeTaskConversationStatusesByAddress(runtimeWork, runtimeTaskLifecycle)
      ),
    [records.bindings.items, runtimeWork, runtimeTaskLifecycle]
  )
  const scope = useRef<object | null>(records.scope)
  useLayoutEffect(() => {
    scope.current = records.scope
    return () => {
      scope.current = null
    }
  }, [records.scope])
  const [selected, setSelected] = useState<{
    scope: object
    delivery: SharedIssueDetailDeliveryDetail
  } | null>(null)
  const [detailError, setDetailError] = useState<object | null>(null)
  const currentDelivery = selected?.scope === records.scope ? selected.delivery : null
  const canCreate = records.actor !== undefined && canStartThreadPersonalTask(context)
  const creationAction = canCreate ? (
    <TodoPersonalTaskAction onCreateTask={() => onCreate(context)} />
  ) : null
  const openDelivery = async (id: string) => {
    try {
      const delivery = await records.port.deliveries.get(id)
      if (scope.current === records.scope) {
        setDetailError(null)
        setSelected({ scope: records.scope, delivery })
      }
    } catch {
      if (scope.current === records.scope) setDetailError(records.scope)
    }
  }
  const error = records.bindings.error || records.deliveries.error
  return (
    <section className="space-y-6 border-t border-border pt-6" data-testid="thread-work-metadata">
      {(records.bindings.loading || records.deliveries.loading) && (
        <p role="status" className="text-sm text-text-muted">
          {t('loading')}
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-text-muted">
          <span>{t('workLoadFailed')}</span>
          <button
            type="button"
            data-testid="thread-work-retry"
            onClick={records.refresh}
            className="rounded px-2 py-1 hover:bg-hover"
          >
            {t('retry')}
          </button>
        </div>
      )}
      {currentDelivery ? (
        <section data-testid="todo-detail-delivery-panel">
          <button
            type="button"
            data-testid="thread-work-delivery-back"
            onClick={() => setSelected(null)}
            className="rounded px-2 py-1 text-sm hover:bg-hover"
          >
            {translate('todo.back')}
          </button>
          <h3 className="mt-3 text-heading-sm">{currentDelivery.title || context.item.title}</h3>
          <IssueDeliveryContent delivery={currentDelivery} translate={translate} />
        </section>
      ) : (
        <>
          {creationAction && records.bindings.items.length === 0 && (
            <section className="task-detail-workspace-section">
              <h3 className="task-detail-workspace-section-title">
                {translate('todo.linked_tasks')}
              </h3>
              {creationAction}
            </section>
          )}
          <IssueLinkedTasks
            tasks={records.bindings.items}
            creationAction={creationAction}
            childItems={[]}
            statusOptions={threadStatuses(collaborationMessages[locale])}
            statusDotClasses={{}}
            taskExecutionStates={taskExecutionStates}
            deviceNamesById={deviceNamesById}
            onOpenTaskConversation={binding => onOpen(context, binding)}
            translate={translate}
          />
          <IssueDeliveries
            deliveries={records.deliveries.items}
            getDelivery={records.port.deliveries.get}
            memberName={id =>
              context.participation?.participants.find(person => person.user_id === id)?.name ??
              null
            }
            onOpen={id => void openDelivery(id)}
            translate={translate}
          />
          {detailError === records.scope && (
            <p role="alert" className="text-sm text-text-muted">
              {t('workLoadFailed')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
