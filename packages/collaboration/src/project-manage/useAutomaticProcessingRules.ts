// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceApi, WorkspaceAutomationRule } from '../ports/SharedWorkspaceApi'

type AutomationsApi = NonNullable<SharedWorkspaceApi['automations']>
type RulesResource = ReturnType<typeof createAsyncResource<WorkspaceAutomationRule[]>>

// Keep the resource within its API session and project; reopening revalidates it.
const resources = new WeakMap<AutomationsApi, Map<string, RulesResource>>()
function rulesResource(api: SharedWorkspaceApi['automations'], projectId: string) {
  let projects = api ? resources.get(api) : undefined
  const cached = projects?.get(projectId)
  if (cached) return cached
  const resource = createAsyncResource(projectId, () => api!.list(projectId), {
    refreshOnSubscribe: true,
  })
  if (api) {
    if (!projects) {
      projects = new Map()
      resources.set(api, projects)
    }
    projects.set(projectId, resource)
  }
  return resource
}

export function useAutomaticProcessingRules(
  api: SharedWorkspaceApi['automations'],
  projectId: string
) {
  const resource = useMemo(() => rulesResource(api, projectId), [api, projectId])
  const query = useSyncExternalStore(
    api ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  return {
    api,
    projectId,
    rules: query.data ?? [],
    loading: Boolean(api && !query.data && (query.status === 'idle' || query.status === 'loading')),
    error: query.status === 'error' ? query.error : null,
    load: resource.reload,
  }
}
