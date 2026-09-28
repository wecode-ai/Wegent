// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationPlatformLocation,
  CollaborationPlatformRootView,
  CollaborationWorkspaceView,
} from '@wegent/collaboration'

const ROOT_PATHS: Record<CollaborationPlatformRootView, string> = {
  home: '/collaboration',
  agents: '/collaboration/agents',
  teams: '/collaboration/teams',
  devices: '/collaboration/devices',
  'my-work': '/collaboration/my-work',
  inbox: '/collaboration/inbox',
  runs: '/collaboration/runs',
}

export function collaborationRootViewForPath(
  pathname: string
): CollaborationPlatformRootView | null {
  return (
    (Object.keys(ROOT_PATHS) as CollaborationPlatformRootView[]).find(
      view => ROOT_PATHS[view] === pathname
    ) ?? null
  )
}

export function collaborationLocationPath(location: CollaborationPlatformLocation): string {
  if (!location.workspaceId) {
    return ROOT_PATHS[location.rootView ?? 'home']
  }
  const workspaceBase = `/collaboration/workspaces/${encodeURIComponent(location.workspaceId)}`
  if (!location.projectId) {
    const suffix: Record<CollaborationWorkspaceView, string> = {
      home: '',
      projects: '/projects',
      members: '/members',
      agents: '/agents',
      'collaboration-participants': '/participants',
      'collaboration-groups': '/collaboration-groups',
      'execution-environments': '/execution-environments',
      settings: '/settings',
    }
    return `${workspaceBase}${suffix[location.workspaceView]}`
  }
  const projectBase = `${workspaceBase}/projects/${encodeURIComponent(location.projectId)}`
  const query = location.projectView === 'board' ? '' : `?view=${location.projectView}`
  return location.issueId
    ? `${projectBase}/issues/${encodeURIComponent(location.issueId)}${query}`
    : `${projectBase}${query}`
}
