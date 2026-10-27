import { mergeIssueReadConfirmation } from '@wegent/collaboration'
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { projectStoreLocation, type ProjectSpaceApi } from './projectSpaceSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { TodoEditor } from './TodoEditor'

interface WorkItemContextPanelProps {
  api: ProjectSpaceApi
  services: Pick<WorkbenchServices, 'projectSpaceDetailServices' | 'runtimeWorkApi'>
  project: CloudProject
  item: CloudLoopItem
  currentTask: RuntimeTaskAddress
  currentUserId?: string | number
  localProjects?: ProjectWithTasks[]
  deviceNamesById?: Readonly<Record<string, string>>
  onOpenBoard: () => void
  onOpenTask: (address: RuntimeTaskAddress) => Promise<void> | void
}

export function WorkItemContextPanel({
  api,
  services,
  project,
  item,
  currentTask,
  currentUserId,
  localProjects,
  deviceNamesById,
  onOpenBoard,
  onOpenTask,
}: WorkItemContextPanelProps) {
  const { t } = useTranslation('common')
  const detailServices =
    services.projectSpaceDetailServices?.[projectStoreLocation(project.project_store)]
  const [currentItem, setCurrentItem] = useState(item)
  const [allItems, setAllItems] = useState<CloudLoopItem[]>([item])

  useEffect(() => {
    let active = true
    void api.listLoopItems(project.id).then(response => {
      if (!active) return
      setAllItems(
        response.items.some(candidate => candidate.id === currentItem.id)
          ? response.items.map(candidate =>
              candidate.id === currentItem.id ? currentItem : candidate
            )
          : [...response.items, currentItem]
      )
    })
    return () => {
      active = false
    }
  }, [api, currentItem, project.id])

  return (
    <section
      data-testid="work-item-context-panel"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <div className="min-h-0 flex-1">
        <TodoEditor
          getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
          mode="edit"
          presentation="workspace-panel"
          workspacePanelFill
          showPanelControls={false}
          headerActions={
            <button
              type="button"
              data-testid="work-item-open-board"
              onClick={onOpenBoard}
              className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary transition hover:bg-muted hover:text-text-primary"
            >
              {t('workbench.open_workspace', '打开工作空间')}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          }
          selectedTaskId={currentTask.taskId}
          deviceNamesById={deviceNamesById}
          api={api}
          projectChatClient={detailServices?.projectChatClient}
          projectChatAgentApi={detailServices?.projectChatAgentApi}
          teamApi={detailServices?.teamApi}
          selfManagedExecution={project.project_store === 'local'}
          currentUserId={project.current_user_id ?? currentUserId}
          localProjects={localProjects}
          item={currentItem}
          project={project}
          allItems={allItems}
          onClose={() => undefined}
          onRead={updated => {
            setCurrentItem(current => mergeIssueReadConfirmation(current, updated))
            setAllItems(items =>
              items.map(candidate =>
                candidate.id === updated.id
                  ? mergeIssueReadConfirmation(candidate, updated)
                  : candidate
              )
            )
          }}
          onUpdated={updated => {
            setCurrentItem(updated)
            setAllItems(items =>
              items.map(candidate => (candidate.id === updated.id ? updated : candidate))
            )
          }}
          onOpenTaskConversation={task =>
            onOpenTask({
              deviceId: task.device_id,
              taskId: task.task_id,
            })
          }
        />
      </div>
    </section>
  )
}
