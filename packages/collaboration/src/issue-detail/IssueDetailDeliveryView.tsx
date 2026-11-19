import { IssueDeliveryContent } from './IssueDeliveryContent'
import { IssueDeliveryEditor } from './IssueDeliveryEditor'
import { ArrowLeft, X } from 'lucide-react'
import { cn } from './issueEditorSupport'
import type { IssueDetailModel } from './useSharedIssueDetailModel'
export function IssueDetailDeliveryView({ model }: { model: IssueDetailModel }) {
  const {
    props,
    onClose,
    editorPort,
    t,
    editable,
    workspacePanel,
    item,
    collections,
    setDeliveries,
    selectedDelivery,
    setSelectedDelivery,
    editingDelivery,
    setEditingDelivery,
    fullScreen,
    editItemId,
    handleKeyDown,
  } = model
  if (!selectedDelivery || !item) return null
  return (
    <aside
      data-testid="todo-detail-delivery-panel"
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
        workspacePanel
          ? cn(
              'task-detail-workspace-panel-shell relative z-10 h-full shrink-0',
              props.workspacePanelFill && 'task-detail-workspace-panel-fill w-full min-w-0',
              fullScreen && 'is-expanded'
            )
          : 'fixed bottom-0 right-0 top-[38px] z-modal w-[min(760px,calc(100vw-48px))] border-l border-border shadow-xl'
      )}
      onKeyDown={handleKeyDown}
    >
      <header className="flex h-12 items-center border-b border-border px-4">
        <button
          type="button"
          data-testid="todo-detail-delivery-back"
          onClick={() => {
            setSelectedDelivery(null)
            setEditingDelivery(null)
          }}
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-hover"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t('todo.back', '返回')}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="todo-detail-delivery-close"
          aria-label={t('common.close', '关闭')}
          onClick={onClose}
          className="h-7 w-7 rounded-lg hover:bg-hover"
        >
          <X className="mx-auto h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="font-mono text-xs text-text-secondary">
          {item.id} · {t('todo.delivered', '已交付')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-heading-md font-semibold">
            {selectedDelivery.title || item.title}
          </h2>
          {editable &&
            editorPort.deliveries.update &&
            editingDelivery?.id !== selectedDelivery.id && (
              <button
                type="button"
                data-testid="delivery-edit"
                onClick={() => setEditingDelivery({ id: selectedDelivery.id })}
                className="h-7 rounded-md px-2 text-sm hover:bg-hover"
              >
                {t('delivery.edit')}
              </button>
            )}
        </div>
        {editingDelivery?.id === selectedDelivery.id ? (
          <IssueDeliveryEditor
            key={selectedDelivery.id}
            delivery={selectedDelivery}
            issueTitle={item.title}
            api={editorPort.deliveries}
            translate={t}
            onCancel={() => setEditingDelivery(null)}
            onSaved={updated => {
              if (!collections.isActive() || editItemId !== updated.loop_item_id) return
              setSelectedDelivery(current => (current?.id === updated.id ? updated : current))
              setDeliveries(current =>
                current.map(delivery => (delivery.id === updated.id ? updated : delivery))
              )
              setEditingDelivery(current => (current === editingDelivery ? null : current))
            }}
          />
        ) : (
          <IssueDeliveryContent delivery={selectedDelivery} translate={t} />
        )}
      </div>
    </aside>
  )
}
