// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from '@playwright/test'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  ProjectChatClient,
  ProjectChatMessage,
  ProjectChatMention,
} from '../../../packages/chat-core/src/project-chat'
import { createSocketClient } from '../../../packages/chat-core/src/socket'
import { createApiClient, type ApiClient, type ApiResponse } from './api-client'
import {
  createExternalIssueHttpFixture,
  type ExternalIssueProvider,
} from './external-issue-http-fixture'

const execFileAsync = promisify(execFile)

interface Resource {
  id: string
  version: number
}

interface Project extends Resource {
  project_key: string
}

interface User {
  id: number
  user_name: string
}

export interface ProjectMember {
  user_id: number
  user_name: string
  direct_role: string | null
  inherited_role: string | null
}

interface Notification {
  id: string
  kind: string
  body: string
  payload: { projectId?: string; itemId?: string; commentId?: string }
}

interface MentionFixture {
  api: ApiClient
  recipientApi: ApiClient
  actor: User
  recipient: User
  recipientPassword: string
  workspace: Resource
  project: Project
  issue: Resource
  projectPath: string
  mention: ProjectChatMention
  chat: (as?: 'actor' | 'recipient') => MentionChat
  external?: {
    setAssignee: (userId: number) => void
    createSiblingIssue: () => Promise<{ project: Project; issue: Resource }>
  }
  messages: (taskId?: string) => Promise<ProjectChatMessage[]>
  inbox: (api?: ApiClient) => Promise<Notification[]>
  grant: (
    source: 'workspace' | 'direct',
    role: 'Maintainer' | 'Developer' | 'Viewer'
  ) => Promise<void>
  setActive: (active: boolean) => Promise<void>
  expectAgentExecution: () => void
}

type MentionChat = Pick<ProjectChatClient, 'send' | 'dispose'> & {
  executeTaskComment: NonNullable<ProjectChatClient['executeTaskComment']>
  subscribe: (
    projectId: string,
    taskId: string | undefined,
    afterSequence: number,
    onMessage: (message: ProjectChatMessage) => void
  ) => Promise<{ snapshot: { messages: ProjectChatMessage[] } }>
}

type ChatAck<T> = { ok: true; result: T } | { ok: false; error: { message: string } }

function connectChat(token: string): MentionChat {
  const client = createSocketClient({
    socketBaseUrl: () => process.env.E2E_API_URL || 'http://localhost:8000',
    namespace: '/wework-runtime',
    path: '/socket.io',
    getToken: () => token,
    auth: { client_origin: 'web' },
    transports: ['websocket'],
    timeout: 15_000,
  })
  const emit = async <T>(event: string, payload: unknown): Promise<T> => {
    await client.ensureConnected()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${event} timed out`)), 15_000)
      client.socket.emit(event, payload, (ack: ChatAck<T>) => {
        clearTimeout(timeout)
        if (ack.ok) resolve(ack.result)
        else reject(new Error(ack.error.message))
      })
    })
  }
  return {
    executeTaskComment: input => emit('wework:project_chat:comment:execute', input),
    send: input =>
      emit('wework:project_chat:message:send', {
        projectId: input.projectId,
        taskId: input.taskId,
        clientMessageId: input.clientMessageId,
        content: input.text,
        mentions: input.mentions ?? [],
        replyToMessageId: input.replyToMessageId,
      }),
    subscribe: async (projectId, taskId, afterSequence, onMessage) => {
      client.socket.on('wework:project_chat:message:created', onMessage)
      const snapshot = await emit<{ messages: ProjectChatMessage[] }>(
        'wework:project_chat:subscribe',
        { projectId, taskId, afterSequence }
      )
      return { snapshot }
    },
    dispose: () => client.dispose(),
  }
}

interface MentionOptions {
  membershipMode: 'inherit' | 'restricted'
  issueSecurity: 'open' | 'related'
  taskProvider: 'local' | ExternalIssueProvider
  localIssueIndex: boolean
  assignedUnavailableAgent: boolean
}

export async function apiData<T>(response: Promise<ApiResponse<T>>): Promise<T> {
  const result = await response
  expect([200, 201], `API returned status ${result.status}`).toContain(result.status)
  expect(result.data).not.toBeNull()
  return result.data!
}

export const test = base.extend<MentionOptions & { mentions: MentionFixture }>({
  membershipMode: ['inherit', { option: true }],
  issueSecurity: ['open', { option: true }],
  taskProvider: ['local', { option: true }],
  localIssueIndex: [false, { option: true }],
  assignedUnavailableAgent: [false, { option: true }],
  mentions: async (
    {
      page,
      request,
      membershipMode,
      issueSecurity,
      taskProvider,
      localIssueIndex,
      assignedUnavailableAgent,
    },
    use
  ) => {
    const token = (await page.context().cookies()).find(
      cookie => cookie.name === 'auth_token'
    )?.value
    if (!token) throw new Error('Mention E2E requires the authenticated setup context')
    const api = createApiClient(request, undefined, token)
    const actor = await apiData(api.get<User>('/api/users/me'))
    const clients: MentionChat[] = []
    let recipient: User | undefined
    let workspace: Resource | undefined
    const projects: Project[] = []
    let provider: Awaited<ReturnType<typeof createExternalIssueHttpFixture>> | undefined
    let recipientToken: string | undefined
    const chat = (as: 'actor' | 'recipient' = 'actor') => {
      const userToken = as === 'actor' ? token : recipientToken
      if (!userToken) throw new Error('Mention recipient has not logged in')
      const client = connectChat(userToken)
      clients.push(client)
      return client
    }
    const archive = async (path: string) => {
      const resource = await apiData(api.get<Resource>(path))
      expect((await api.delete(`${path}?version=${resource.version}`)).status).toBe(204)
    }
    let assignedIssueId: string | undefined
    let runnerSeeded = false
    let agentExecutionExpected = false
    const manageRunner = async (action: 'seed' | 'check' | 'check-agent' | 'cleanup') => {
      if (!process.env.DATABASE_URL || !assignedIssueId)
        throw new Error('Assigned mention E2E requires an Issue and DATABASE_URL')
      await execFileAsync(
        'uv',
        [
          'run',
          '--no-sync',
          'python',
          'tests/e2e/project_mention_runner.py',
          action,
          assignedIssueId,
        ],
        {
          cwd: resolve(__dirname, '../../../backend'),
          env: { ...process.env, PYTHONPATH: '.:..' },
          timeout: 15_000,
        }
      )
    }
    const manageIndex = async (projectId: string, action: 'seed' | 'check' | 'cleanup') => {
      if (!process.env.DATABASE_URL)
        throw new Error('External Issue E2E requires the running service DATABASE_URL')
      await execFileAsync(
        'uv',
        [
          'run',
          '--no-sync',
          'python',
          'tests/e2e/project_mention_index.py',
          action,
          projectId,
          localIssueIndex ? 'present' : 'absent',
        ],
        {
          cwd: resolve(__dirname, '../../../backend'),
          env: { ...process.env, PYTHONPATH: '.:..' },
          timeout: 15_000,
        }
      )
    }

    try {
      const suffix = crypto.randomUUID()
      const password = `Mention-${crypto.randomUUID()}`
      recipient = await apiData(
        api.post<User>('/api/admin/users', {
          user_name: `mention-${suffix}`,
          password,
          role: 'user',
        })
      )
      const recipientApi = createApiClient(request)
      recipientToken = (await apiData(recipientApi.login(recipient.user_name, password, 1)))
        .access_token
      workspace = await apiData(
        api.post<Resource>('/api/v1/workspaces', { name: `Mentions ${suffix}` })
      )
      const workspaceId = workspace.id
      const recipientId = recipient.id
      if (taskProvider !== 'local')
        provider = await createExternalIssueHttpFixture(taskProvider, actor.id, issueSecurity)
      const createProject = async () => {
        const project = await apiData(
          api.post<Project>('/api/v1/cloud-projects', {
            name: `Mentions ${crypto.randomUUID()}`,
            workspace_id: workspaceId,
            membership_mode: membershipMode,
            default_issue_security: issueSecurity,
            task_provider: taskProvider,
            ...(provider ? { provider_config: provider.config } : {}),
            visibility: 'private',
          })
        )
        projects.push(project)
        if (provider) await manageIndex(project.id, 'seed')
        const issue = provider
          ? { id: `${project.project_key}-1`, version: 1 }
          : await apiData(
              api.post<Resource>(`/api/v1/cloud-projects/${project.id}/loop-items`, {
                title: `Mention Issue ${suffix}`,
                notify_assignee: false,
              })
            )
        return { project, issue }
      }
      const { project, issue } = await createProject()
      if (assignedUnavailableAgent) {
        if (taskProvider !== 'local') throw new Error('Assigned mention E2E requires a local Issue')
        assignedIssueId = issue.id
        await manageRunner('seed')
        runnerSeeded = true
      }
      const projectId = project.id
      await use({
        api,
        recipientApi,
        actor,
        recipient,
        recipientPassword: password,
        workspace,
        project,
        issue,
        projectPath: `/collaboration/workspaces/${workspaceId}/projects/${projectId}`,
        mention: { type: 'user', id: String(recipientId), label: recipient.user_name },
        chat,
        ...(provider
          ? { external: { setAssignee: provider.setAssignee, createSiblingIssue: createProject } }
          : {}),
        messages: async taskId => {
          // A fresh connection reads committed history rather than an optimistic UI cache.
          const client = chat()
          try {
            const subscription = await client.subscribe(projectId, taskId, 0, () => {})
            return subscription.snapshot.messages
          } finally {
            client.dispose()
          }
        },
        inbox: async (userApi = recipientApi) => {
          const inbox = await apiData(
            userApi.get<{ items: Notification[] }>(
              '/api/v1/wework-notifications?category=collaboration&limit=100'
            )
          )
          return inbox.items.filter(item => item.payload.projectId === projectId)
        },
        grant: async (source, role) => {
          const path =
            source === 'workspace'
              ? `/api/v1/workspaces/${workspaceId}/members`
              : `/api/v1/cloud-projects/${projectId}/members`
          await apiData(api.post(path, { user_id: recipientId, role }))
        },
        setActive: async active => {
          await apiData(api.put(`/api/admin/users/${recipientId}`, { is_active: active }))
        },
        expectAgentExecution: () => {
          agentExecutionExpected = true
        },
      })
      if (assignedUnavailableAgent)
        await manageRunner(agentExecutionExpected ? 'check-agent' : 'check')
      if (provider) {
        for (const project of projects) await manageIndex(project.id, 'check')
        expect(
          provider.requests.length,
          'The real backend must call the provider HTTP mock'
        ).toBeGreaterThan(0)
        expect(provider.requests.filter(request => request.status !== 200)).toEqual([])
      }
    } finally {
      clients.forEach(client => client.dispose())
      try {
        try {
          if (runnerSeeded) await manageRunner('cleanup')
        } finally {
          for (const project of projects) {
            if (provider) await manageIndex(project.id, 'cleanup')
            await archive(`/api/v1/cloud-projects/${project.id}`)
          }
        }
      } finally {
        try {
          if (workspace) await archive(`/api/v1/workspaces/${workspace.id}`)
        } finally {
          try {
            if (recipient)
              expect((await api.delete(`/api/admin/users/${recipient.id}`)).status).toBe(204)
          } finally {
            await provider?.close()
          }
        }
      }
    }
  },
})
