import { useMemo } from 'react'
import {
  useCollaborationWorkspaceController,
  type SharedWorkspaceApi,
  type WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeWorkListResponse } from '@/types/api'
import { CloudMyWorkView } from './CloudMyWorkView'
import { isRuntimeMyWorkItem, runtimeMyWorkItems, type RuntimeMyWorkItem } from './runtimeMyWork'

interface TaskMyWorkViewProps {
  api?: SharedWorkspaceApi
  runtimeWork: RuntimeWorkListResponse | null
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot
  onOpenCloudItem: (item: WorkspaceMyWorkItem) => void
  onOpenRuntimeItem: (item: RuntimeMyWorkItem) => void
}

const messages = {
  loadFailed: '任务加载失败',
  saveFailed: '任务更新失败',
  conflict: '任务已更新，请重试',
}

export function TaskMyWorkView({
  api,
  runtimeWork,
  runtimeTaskLifecycle,
  onOpenCloudItem,
  onOpenRuntimeItem,
}: TaskMyWorkViewProps) {
  const { t } = useTranslation('common')
  const workspace = useCollaborationWorkspaceController({
    api,
    location: {
      projectId: null,
      issueId: null,
      view: 'board',
      rootView: 'my-work',
    },
    messages,
    loadProjectOnLocation: false,
    preloadHomeSnapshots: false,
  })
  const cloudItems = workspace.state.myWork
  const items = useMemo(() => {
    const cloudIssueIds = new Set(cloudItems.map(item => item.id))
    return [
      ...cloudItems,
      ...runtimeMyWorkItems(runtimeWork, runtimeTaskLifecycle).filter(
        item => !item.cloud_issue_id || !cloudIssueIds.has(item.cloud_issue_id)
      ),
    ]
  }, [cloudItems, runtimeTaskLifecycle, runtimeWork])

  const openItem = (item: WorkspaceMyWorkItem | RuntimeMyWorkItem) => {
    if (isRuntimeMyWorkItem(item)) {
      onOpenRuntimeItem(item)
      return
    }
    onOpenCloudItem(item)
  }

  const approveItem = async (item: WorkspaceMyWorkItem | RuntimeMyWorkItem) => {
    if (isRuntimeMyWorkItem(item) || !api) return
    await api.issues.approveRun(String(item.cloud_project_id), item.id, item.version)
    await workspace.commands.loadMyWork()
  }

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="task-my-work-surface">
      {workspace.state.error ? (
        <div
          className="absolute left-1/2 top-4 z-overlay -translate-x-1/2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {workspace.state.error}
        </div>
      ) : null}
      <CloudMyWorkView
        items={items}
        title={t('workbench.work_item_create_title', '我的任务')}
        onSelectItem={openItem}
        onApproveItem={approveItem}
      />
    </div>
  )
}
