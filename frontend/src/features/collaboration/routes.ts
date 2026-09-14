// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from '@wegent/collaboration'

export function collaborationLocationPath(location: CollaborationPlatformLocation): string {
  if (!location.workspaceId) {
    return '/collaboration'
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
