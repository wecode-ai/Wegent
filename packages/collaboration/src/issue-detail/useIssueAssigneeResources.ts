// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { CollaborationOwnedAgent, CollaborationProject } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'

export function useIssueAssigneeResources(
  port: SharedIssueDetailPort,
  project: CollaborationProject | undefined,
  onError: (message: string) => void,
  assignedAgentId?: string | null
) {
  const { id, workspace_id, project_store, access_role, workspace_access_role } = project ?? {}
  const input = useMemo(
    () => ({
      id,
      workspace_id,
      project_store,
      access_role,
      workspace_access_role,
    }),
    [id, workspace_id, project_store, access_role, workspace_access_role]
  )
  const resource = useMemo(
    () =>
      createAsyncResource<CollaborationOwnedAgent[]>(
        JSON.stringify([input, assignedAgentId]),
        () =>
          port.agentResources!.list({
            ...input,
            id: input.id!,
            project_store: input.project_store!,
          }),
        {
          refreshOnSubscribe: true,
          failure: cause => onError(cause instanceof Error ? cause.message : String(cause)),
        }
      ),
    [port, input, assignedAgentId, onError]
  )
  const query = useSyncExternalStore(
    id && project_store && port.agentResources ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  return query.data ?? []
}
