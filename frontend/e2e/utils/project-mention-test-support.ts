// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from '@playwright/test'
import type {
  ProjectChatClient,
  ProjectChatMessage,
  ProjectChatMention,
} from '../../../packages/chat-core/src/project-chat'
import { createSocketClient } from '../../../packages/chat-core/src/socket'
import { createApiClient, type ApiClient, type ApiResponse } from './api-client'

interface Resource {
  id: string
  version: number
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
  workspace: Resource
  project: Resource
  issue: Resource
  projectPath: string
  mention: ProjectChatMention
  chat: () => MentionChat
  messages: (taskId?: string) => Promise<ProjectChatMessage[]>
  inbox: (api?: ApiClient) => Promise<Notification[]>
  grant: (
    source: 'workspace' | 'direct',
    role: 'Maintainer' | 'Developer' | 'Viewer'
  ) => Promise<void>
  setActive: (active: boolean) => Promise<void>
}

type MentionChat = Pick<ProjectChatClient, 'send' | 'dispose'> & {
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
  mentions: async ({ page, request, membershipMode, issueSecurity }, use) => {
    const token = (await page.context().cookies()).find(
      cookie => cookie.name === 'auth_token'
    )?.value
    if (!token) throw new Error('Mention E2E requires the authenticated setup context')
    const api = createApiClient(request, undefined, token)
    const actor = await apiData(api.get<User>('/api/users/me'))
    const clients: MentionChat[] = []
    let recipient: User | undefined
    let workspace: Resource | undefined
    let project: Resource | undefined
    const chat = () => {
      const client = connectChat(token)
      clients.push(client)
      return client
    }
    const archive = async (path: string) => {
      const resource = await apiData(api.get<Resource>(path))
      expect((await api.delete(`${path}?version=${resource.version}`)).status).toBe(204)
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
      await apiData(recipientApi.login(recipient.user_name, password, 1))
      workspace = await apiData(
        api.post<Resource>('/api/v1/workspaces', { name: `Mentions ${suffix}` })
      )
      project = await apiData(
        api.post<Resource>('/api/v1/cloud-projects', {
          name: `Mentions ${suffix}`,
          workspace_id: workspace.id,
          membership_mode: membershipMode,
          default_issue_security: issueSecurity,
          task_provider: 'local',
          visibility: 'private',
        })
      )
      const projectId = project.id
      const workspaceId = workspace.id
      const recipientId = recipient.id
      const issue = await apiData(
        api.post<Resource>(`/api/v1/cloud-projects/${projectId}/loop-items`, {
          title: `Mention Issue ${suffix}`,
          notify_assignee: false,
        })
      )
      await use({
        api,
        recipientApi,
        actor,
        recipient,
        workspace,
        project,
        issue,
        projectPath: `/collaboration/workspaces/${workspaceId}/projects/${projectId}`,
        mention: { type: 'user', id: String(recipientId), label: recipient.user_name },
        chat,
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
      })
    } finally {
      clients.forEach(client => client.dispose())
      try {
        if (project) await archive(`/api/v1/cloud-projects/${project.id}`)
      } finally {
        try {
          if (workspace) await archive(`/api/v1/workspaces/${workspace.id}`)
        } finally {
          if (recipient)
            expect((await api.delete(`/api/admin/users/${recipient.id}`)).status).toBe(204)
        }
      }
    }
  },
})
