// @vitest-environment node

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import { createWeworkPlatformApi } from './weworkPlatformApi'

function fixture() {
  const context = { operationId: 'operation', stepKey: 'group:main' }
  const imports = { begin: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue([]) }
  const cloud = {
    templateImports: imports,
    workspaces: {},
    projects: { update: vi.fn(), createCollaborationGroup: vi.fn() },
    agents: { create: vi.fn() },
    automations: { create: vi.fn() },
    issues: {},
    members: {},
  } as unknown as SharedWorkspaceApi
  const local = {
    projects: { list: vi.fn().mockResolvedValue([{ id: 'local-project' }]) },
    agents: {},
    issues: {},
    members: {},
  } as unknown as SharedWorkspaceApi
  return { api: createWeworkPlatformApi(cloud, local)!, cloud, local, imports, context }
}

describe('template import project ownership', () => {
  it('discovers cloud receipts while keeping local projects on their local flow', async () => {
    const { api, imports } = fixture()
    await expect(api.templateImports!.supports!('local-project')).resolves.toBe(false)
    await expect(api.templateImports!.supports!('cloud-project')).resolves.toBe(true)
    await expect(api.templateImports!.list('local-project')).resolves.toEqual([])
    expect(imports.list).not.toHaveBeenCalled()
    await expect(api.templateImports!.get('local-project', 'operation')).rejects.toThrow(
      'cloud project'
    )
    expect(imports.get).not.toHaveBeenCalled()
    await api.templateImports!.list('cloud-project')
    expect(imports.list).toHaveBeenCalledExactlyOnceWith('cloud-project')
  })

  it('preserves the receipt context across all cloud project write adapters', async () => {
    const { api, cloud, context } = fixture()
    const projectInput = { version: 1 }
    await api.projects.update('cloud-project', projectInput, context)
    expect(cloud.projects.update).toHaveBeenCalledWith('cloud-project', projectInput, context)
    const agentInput = { name: 'Imported' }
    await api.agents.create('cloud-project', agentInput, context)
    expect(cloud.agents.create).toHaveBeenCalledWith('cloud-project', agentInput, context)
    const groupInput = {
      name: 'Imported',
      leader: { kind: 'human' as const, id: '1' },
      members: [],
      stages: [],
    }
    await api.projects.createCollaborationGroup!('cloud-project', groupInput, context)
    expect(cloud.projects.createCollaborationGroup).toHaveBeenCalledWith(
      'cloud-project',
      groupInput,
      context
    )
    const automationInput = { name: 'Imported' } as Parameters<
      NonNullable<SharedWorkspaceApi['automations']>['create']
    >[1]
    await api.automations!.create('cloud-project', automationInput, context)
    expect(cloud.automations!.create).toHaveBeenCalledWith(
      'cloud-project',
      automationInput,
      context
    )
  })
})
