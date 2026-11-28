// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createCloudRuntimeIpcClient } from '../../../packages/chat-core/src/runtime-ipc'
import { PROVIDER_NATIVE_API_URL } from './provider-native-test-support'

interface Source {
  teamId: number
  name: string
  mode: string
  agentId: string
  leadPrompt: string
  workerPrompt: string
  final: string
  workerResult: string
  bots: { bot_id: number; role: string }[]
}
interface Role {
  id: string
  teamRef?: string
}
interface Profile {
  executionDeviceId: string
  roles: Role[]
  teams?: { id: string }[]
}
interface Grant {
  skills: string[]
  skill_refs: Record<string, unknown>
  mcp_servers: Record<string, unknown>
}

export async function verifySameSourceTeams(
  sources: Source[],
  ctx: {
    page: Page
    projectId: string
    token: string
    model: string
    grants: Grant[]
    api<T>(path: string): Promise<T>
    put<T>(path: string, data: unknown): Promise<T>
    prepare(source: Source): Promise<void>
    receipts(source: Source): Promise<string[]>
  }
) {
  const { page } = ctx
  const deviceId = process.env.E2E_COMPACTION_DEVICE_ID || 'e2e-claudecode-compaction-device'
  const client = createCloudRuntimeIpcClient({
    socketBaseUrl: PROVIDER_NATIVE_API_URL,
    socketPath: '/socket.io',
    getToken: () => ctx.token,
  })
  const rpc = <T>(method: string, params: Record<string, unknown>) =>
    client.request<T>(method, params, deviceId, 30000)
  const { id: userId } = await ctx.api<{ id: number }>('/api/users/me')
  const profile = () => rpc<Profile>('runtime.stand_in.personal.get', { userId })
  const sourceId = randomUUID()
  const root = {
    id: sourceId,
    name: sourceId,
    leadId: sources.find(source => source.mode === 'coordinate')!.name,
    members: Object.fromEntries(sources.map(s => [s.name, s.mode])),
  }
  const memberDefinitions: Record<string, unknown> = {}
  const deliveries = []
  try {
    const settings = await profile()
    expect(settings.executionDeviceId).toBe(deviceId)
    const binding = await rpc<{ version: number; status: string; target: unknown }>(
      'runtime.stand_in.binding',
      { operation: 'get' }
    )
    const target = {
      userId,
      deviceId,
      backendUrl: process.env.E2E_DEVICE_BACKEND_URL || PROVIDER_NATIVE_API_URL,
    }
    if (binding.status === 'unbound') {
      await rpc('runtime.stand_in.binding', { operation: 'bind', version: binding.version, target })
    } else {
      expect(binding.target).toMatchObject(target)
    }
    if (binding.status !== 'active') {
      await rpc('runtime.stand_in.personal.lifecycle', { userId, operation: 'start' })
    }
    for (const source of sources) {
      const stored = await ctx.api<{
        name: string
        user_id: number
        bots: {
          bot_id: number
          role: string
          contextPassing?: string
          requireConfirmation?: boolean
          bot_prompt?: string
        }[]
      }>('/api/teams/' + source.teamId)
      expect(stored.user_id).toBe(userId)
      expect(stored.name).toBe(source.name)
      expect(stored.bots.map(b => b.bot_id)).toEqual(source.bots.map(b => b.bot_id))
      const bot = await Promise.all(
        stored.bots.map(async member => {
          const resource = await ctx.api<{
            id: number
            name: string
            shell_type: string
            system_prompt: string
          }>('/api/bots/' + member.bot_id)
          expect(resource.shell_type).toBe('Codex')
          return {
            id: resource.id,
            name: resource.name,
            role: member.role,
            shell_type: resource.shell_type,
            system_prompt: resource.system_prompt,
            prompt: member.bot_prompt ?? '',
            context_passing: member.contextPassing ?? 'none',
            require_confirmation: member.requireConfirmation ?? false,
          }
        })
      )
      const definition = { name: source.name, collaboration_model: source.mode, bot }
      const current = await profile()
      const role = {
        id: source.name,
        name: source.name,
        enabled: true,
        executionDeviceId: deviceId,
        version: 0,
        tags: [],
        prompt: '',
        migrationSource: JSON.stringify([deviceId, userId, source.name]),
        collaboration: {
          enabled: false,
          allProjects: true,
          projects: [],
          excludedProjects: [],
          tags: [],
        },
      }
      const saved = await rpc<Profile>('runtime.stand_in.personal.save', {
        userId,
        transferRoleId: role.id,
        settings: { ...current, roles: [...current.roles, role] },
        portableTeam: definition,
      })
      const teamRef = saved.roles.find(r => r.id === role.id)?.teamRef
      expect(teamRef).toBeTruthy()
      await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: saved,
        ownedTeam: {
          roleId: role.id,
          botGrants: bot.map(({ id }, index) => {
            const { skills, skill_refs, mcp_servers } =
              ctx.grants[source.mode === 'pipeline' ? index : 0]
            return { id, skills, skill_refs, mcp_servers }
          }),
        },
      })
      const exported = await rpc<{ portableTeam: typeof definition }>(
        'runtime.stand_in.personal.get',
        {
          userId,
          exportTeamRoleId: role.id,
        }
      )
      expect(exported.portableTeam.bot).toMatchObject(bot)
      memberDefinitions[source.name] = exported.portableTeam
    }
    const current = await profile()
    const registered = await rpc<Profile>('runtime.stand_in.personal.save', {
      userId,
      settings: { ...current, teams: [...(current.teams ?? []), root] },
    })
    const savedRoot = registered.teams?.find(team => team.id === sourceId)
    expect(savedRoot).toMatchObject(root)
    const adoption = await ctx.put<{ group_id: string }>(
      '/api/v1/cloud-projects/' + ctx.projectId + '/personal-team-bindings/' + sourceId,
      {
        root: { kind: 'team', definition: root },
        member_agent_ids: Object.fromEntries(sources.map(s => [s.name, s.agentId])),
        member_team_definitions: memberDefinitions,
      }
    )
    const groups = await ctx.api<{
      items: { id: string; members: { id: string }[]; personal_team_managed: boolean }[]
    }>('/api/v1/cloud-projects/' + ctx.projectId + '/collaboration-groups')
    const group = groups.items.find(g => g.id === adoption.group_id)
    expect(group?.personal_team_managed).toBe(true)
    expect(group?.members.map(m => m.id).sort()).toEqual(sources.map(s => s.agentId).sort())
    for (const source of sources) {
      await ctx.prepare(source)
      const address = await rpc<{ taskId: string; deviceId: string }>(
        'runtime.stand_in.conversation',
        {
          userId,
          roleId: source.name,
          message: 'Prepare the release ' + sourceId,
          options: {
            ...(source.name === root.leadId ? { conversationScope: 'team:' + sourceId } : {}),
            modelId: ctx.model,
            modelType: 'user',
            modelOptions: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: String(userId),
            },
          },
        }
      )
      expect(address).toMatchObject({
        taskId:
          source.name === root.leadId
            ? `stand-in-team-chat-${userId}-${sourceId}-${source.name}`
            : `stand-in-chat-${userId}-role-${source.name}`,
        deviceId,
      })
      const result = source.mode === 'pipeline' ? source.workerResult : source.final
      await expect
        .poll(
          async () => {
            const { task } = await rpc<{ task: { status: string } }>('runtime.tasks.get', {
              taskId: address.taskId,
            })
            if (['failed', 'cancelled'].includes(task.status))
              throw Error('Personal Team ' + source.name + ' ended ' + task.status)
            if (task.status !== 'done') return ''
            try {
              const transcript = await rpc<{ messages: unknown[] }>('runtime.tasks.transcript', {
                taskId: address.taskId,
              })
              return JSON.stringify(transcript.messages)
            } catch (error) {
              // A completed stage can yield its thread before the next stage loads it.
              if (
                error instanceof Error &&
                error.message.startsWith('codex_error: thread not loaded: ')
              )
                return error.message
              throw error
            }
          },
          { timeout: 90000, message: 'Personal Team delivery for ' + source.name }
        )
        .toContain(result)
      const personalReceipts = await ctx.receipts(source)
      await ctx.prepare(source)
      await page.goto('/chat?teamId=' + source.teamId)
      const input = page.getByTestId('message-input')
      await expect(input).toHaveAttribute('data-team-id', String(source.teamId))
      await input.fill('Prepare the platform release ' + sourceId)
      await page.getByTestId('send-button').click()
      await expect(page).toHaveURL(url => Boolean(url.searchParams.get('taskId')), {
        timeout: 20000,
      })
      const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
      const readTurns = async () =>
        (
          await ctx.api<{
            subtasks: {
              id: number
              role: string
              status: string
              team_id: number
              bot_ids: number[]
            }[]
          }>('/api/tasks/' + taskId)
        ).subtasks.filter(t => t.role === 'ASSISTANT')
      const expectedBotIds = source.bots.map(bot => bot.bot_id)
      await expect
        .poll(
          async () => {
            const turns = await readTurns()
            const failed = turns.find(turn => ['FAILED', 'CANCELLED'].includes(turn.status))
            if (failed)
              throw Error(
                'Platform task ' + taskId + ' subtask ' + failed.id + ' ended ' + failed.status
              )
            return turns.map(turn => [turn.team_id, turn.status])
          },
          { timeout: 90000, message: 'Platform Team delivery for ' + source.name }
        )
        .toEqual(
          Array.from({ length: source.mode === 'pipeline' ? 2 : 1 }, () => [
            source.teamId,
            'COMPLETED',
          ])
        )
      const turns = await readTurns()
      if (source.mode === 'pipeline')
        expect(turns.map(turn => turn.bot_ids)).toEqual(expectedBotIds.map(id => [id]))
      else {
        expect(turns[0].bot_ids).toContain(expectedBotIds[0])
        expect(turns[0].bot_ids.every(id => expectedBotIds.includes(id))).toBe(true)
      }
      const platformReceipts = await ctx.receipts(source)
      expect(new Set([...personalReceipts, ...platformReceipts]).size).toBe(4)
      deliveries.push({
        teamId: source.teamId,
        agentId: source.agentId,
        botIds: source.bots.map(b => b.bot_id),
        teamRef: registered.roles.find(role => role.id === source.name)!.teamRef,
        personalTaskId: address.taskId,
        personalReceipts,
        platformTaskId: taskId,
        platformSubtasks: turns.map(({ id, bot_ids }) => ({ id, botIds: bot_ids })),
        platformReceipts,
      })
    }
    return { sourceId, userId, deviceId, projectId: ctx.projectId, adoption, deliveries }
  } finally {
    client.dispose()
  }
}
