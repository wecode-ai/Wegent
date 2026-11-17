// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'

export interface ProjectSnapshotWriteGuard {
  projectId: string | null
  issueIds: ReadonlySet<string>
  canWrite: boolean
  message: string
  acceptProject?(project: CollaborationProject): void
}

const structuralIssueFields = [
  'status',
  'tags',
  'position',
  'parentId',
  'assigneeUserId',
  'assigneeAgentId',
  'assigneeGroupId',
  'assigneeTeamId',
] as const satisfies readonly (keyof Parameters<SharedWorkspaceApi['issues']['update']>[1])[]

export function guardProjectSnapshotWrites(
  api: SharedWorkspaceApi,
  getGuard: () => ProjectSnapshotWriteGuard
): SharedWorkspaceApi {
  const assertProjectWritable = (projectId: string) => {
    const guard = getGuard()
    if (guard.projectId === projectId && !guard.canWrite) throw new Error(guard.message)
  }
  return {
    ...api,
    projects: {
      ...api.projects,
      async update(...args: Parameters<SharedWorkspaceApi['projects']['update']>) {
        assertProjectWritable(args[0])
        const project = await api.projects.update(...args)
        const guard = getGuard()
        if (guard.projectId === args[0]) guard.acceptProject?.(project)
        return project
      },
    },
    issues: {
      ...api.issues,
      async create(...args: Parameters<SharedWorkspaceApi['issues']['create']>) {
        assertProjectWritable(args[0])
        return api.issues.create(...args)
      },
      async update(...args: Parameters<SharedWorkspaceApi['issues']['update']>) {
        const guard = getGuard()
        if (
          guard.projectId !== null &&
          !guard.canWrite &&
          guard.issueIds.has(args[0]) &&
          structuralIssueFields.some(field => field in args[1])
        ) {
          throw new Error(guard.message)
        }
        return api.issues.update(...args)
      },
      async reorder(...args: Parameters<SharedWorkspaceApi['issues']['reorder']>) {
        assertProjectWritable(args[0])
        return api.issues.reorder(...args)
      },
      async assign(...args: Parameters<SharedWorkspaceApi['issues']['assign']>) {
        assertProjectWritable(args[0])
        return api.issues.assign(...args)
      },
    },
  }
}
