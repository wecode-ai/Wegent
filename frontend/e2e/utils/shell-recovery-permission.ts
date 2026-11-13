// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import type { ApiClient } from './api-client'

export async function assertShellRecoveryPermission(
  creator: ApiClient,
  editor: ApiClient,
  team: { teamId: number; botId: number },
  botPath: string,
  namespace: string
): Promise<void> {
  const original = await creator.get<{ spec: Record<string, unknown> }>(botPath)
  expect(original.status, JSON.stringify(original.data)).toBe(200)
  const detail = await creator.get<{ system_prompt: string }>(`/api/bots/${team.botId}`)
  expect(detail.status, JSON.stringify(detail.data)).toBe(200)
  const name = `e2e-owner-private-shell-${team.botId}`
  const shellPath = `/api/v1/namespaces/default/shells/${name}`
  const created = await creator.post('/api/v1/namespaces/default/shells', {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Shell',
    metadata: { name, namespace: 'default' },
    spec: { shellType: 'Chat' },
  })
  expect(created.status, JSON.stringify(created.data)).toBe(201)
  const staleRef = { name, namespace }
  const groupShellPath = `/api/v1/namespaces/${namespace}/shells/${name}`
  let groupShellExists = false

  try {
    const groupShell = await editor.post(`/api/v1/namespaces/${namespace}/shells`, {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Shell',
      metadata: { name, namespace },
      spec: { shellType: 'Chat' },
    })
    expect(groupShell.status, JSON.stringify(groupShell.data)).toBe(201)
    groupShellExists = true
    const stale = await creator.put(botPath, {
      ...original.data,
      spec: { ...original.data!.spec, shellRef: staleRef },
    })
    expect(stale.status, JSON.stringify(stale.data)).toBe(200)
    // Delete a real dependency to leave an unresolved reference without bypassing validation.
    const deletedGroupShell = await editor.delete(groupShellPath)
    expect(deletedGroupShell.status, JSON.stringify(deletedGroupShell.data)).toBe(200)
    groupShellExists = false
    const denied = await editor.put(`/api/bots/${team.botId}`, {
      team_id: team.teamId,
      shell_name: name,
      system_prompt: 'An unresolved reference must not grant private Shell access.',
    })
    expect(denied.status, JSON.stringify(denied.data)).toBe(403)
    const saved = await creator.get<{ spec: Record<string, unknown> }>(botPath)
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect(saved.data?.spec).toEqual({ ...original.data!.spec, shellRef: staleRef })
    const savedDetail = await creator.get<{ system_prompt: string }>(`/api/bots/${team.botId}`)
    expect(savedDetail.status, JSON.stringify(savedDetail.data)).toBe(200)
    expect(savedDetail.data?.system_prompt).toBe(detail.data?.system_prompt)
  } finally {
    const restored = await creator.put(botPath, original.data)
    expect(restored.status, JSON.stringify(restored.data)).toBe(200)
    if (groupShellExists) {
      const removedGroupShell = await editor.delete(groupShellPath)
      expect(removedGroupShell.status, JSON.stringify(removedGroupShell.data)).toBe(200)
    }
    const removed = await creator.delete(shellPath)
    expect(removed.status, JSON.stringify(removed.data)).toBe(200)
  }
}
