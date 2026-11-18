// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { apiClient } from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import MessagesArea from '@/features/tasks/components/message/MessagesArea'
import { ChatEvidenceHost } from '@/features/tasks/components/message/evidence/ChatEvidenceHost'
import {
  TaskSourceDecisions,
  useTaskSourceDecisions,
} from '@/features/tasks/components/message/evidence/sourceAccess'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task } from '@/types/api'
import { useKnowledgePermissions } from '../../permission/hooks/useKnowledgePermissions'
import { KnowledgeUrlStatus } from './KnowledgeUrlStatus'

export function KnowledgeReadOnlyHistory({
  knowledgeBaseId,
  taskId,
  permissionRefreshKey = 0,
}: {
  knowledgeBaseId: number
  taskId: number
  permissionRefreshKey?: number
}) {
  const { user } = useUser()
  const mobile = useIsMobile()
  const {
    selectTask,
    selectedTaskDetail,
    accessDenied,
    taskState,
    recoverCurrentTask,
    denySelectedTaskAccess,
  } = useTaskSession()
  const { myPermission, error, fetchMyPermission } = useKnowledgePermissions({
    kbId: knowledgeBaseId,
    taskId,
  })
  const scope = JSON.stringify([user?.id, apiClient.getCacheScope(), knowledgeBaseId, taskId])
  const [activatedScope, setActivatedScope] = useState<string>()
  const taskBound = myPermission?.task_source_bound === true
  const taskSources = useTaskSourceDecisions(taskId, denySelectedTaskAccess, {
    key: JSON.stringify([scope, permissionRefreshKey]),
    knowledgeBaseId,
    directAccessDenied: myPermission?.has_access === false,
  })

  useEffect(() => {
    void fetchMyPermission()
  }, [fetchMyPermission, permissionRefreshKey])

  useEffect(() => {
    if (!taskBound || activatedScope === scope) return
    // Drop messages from any previous account, Backend or task before reading history.
    selectTask(null)
    selectTask({ id: taskId } as Task)
    setActivatedScope(scope)
  }, [activatedScope, scope, selectTask, taskBound, taskId])

  if (error) return <KnowledgeUrlStatus status="error" onRetry={fetchMyPermission} />
  if (!myPermission) return <KnowledgeUrlStatus status="loading" onRetry={fetchMyPermission} />
  if (!taskBound || (activatedScope === scope && accessDenied)) {
    return <KnowledgeUrlStatus status="not-found" onRetry={fetchMyPermission} />
  }
  if (activatedScope !== scope || selectedTaskDetail?.id !== taskId) {
    return (
      <KnowledgeUrlStatus
        status={taskState?.taskId === taskId && taskState.phase === 'error' ? 'error' : 'loading'}
        onRetry={() => void recoverCurrentTask()}
      />
    )
  }
  if (selectedTaskDetail.task_type !== 'knowledge') {
    return <KnowledgeUrlStatus status="not-found" onRetry={fetchMyPermission} />
  }

  return (
    <TaskSourceDecisions.Provider value={taskSources}>
      <ChatEvidenceHost mobile={mobile} taskKey={scope}>
        <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="knowledge-workspace-chat">
          <MessagesArea
            currentTaskId={taskId}
            isGroupChat={selectedTaskDetail.is_group_chat}
            hasMessages
            hideGroupChatOptions
            readOnly
          />
        </div>
      </ChatEvidenceHost>
    </TaskSourceDecisions.Provider>
  )
}
