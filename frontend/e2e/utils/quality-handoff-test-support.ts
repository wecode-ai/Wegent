// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { createApiClient, createBackendRequestHeaders } from './api-client'
import { webApi } from './collaboration-test-support'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const execFileAsync = promisify(execFile)

export interface QualityUser {
  id: number
  user_name: string
  password: string
}

export type QualityAccount = { password: string; user_name?: string; username?: string }

export interface QualityHandoff {
  acceptance_complete?: boolean
  quality_blocked?: boolean
  reason_code?: string | null
  required_assignee_role?: string
  reviews?: Record<string, { decision: string; review_role: string }>
}

export interface QualityIssue {
  id: string
  version: number
  status: string
  assignee_user_id: number | null
  tags: string[]
  assignment_history?: unknown[]
  quality_handoff?: QualityHandoff | null
  badges?: Array<{ icon: string; url: string }>
  workflow: { current_stage_id: string | null }
}

export interface QualityIncomingHook {
  id: string
  collectionMode: 'webhook' | 'poll' | 'internal' | 'hybrid'
  webhookUrl: string | null
}

export interface QualityIncomingEvent {
  id: string
  status: string
  normalizedEvents: Array<{ event_type: string }>
}

export interface QualityNotification {
  kind: string
  payload: { itemId?: string; issueId?: string; reason?: string }
}

export interface QualityNotificationCounts {
  assignments: number
  total: number
}

export async function createQualityUsers(
  page: Page,
  projectId: string,
  suffix: string
): Promise<Record<'qa' | 'product' | 'ui', QualityUser>> {
  const create = async (role: 'qa' | 'product' | 'ui'): Promise<QualityUser> => {
    const password = `Quality-${role}-${suffix}-${crypto.randomUUID()}`
    const accountId = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
    const user = await webApi<{ id: number; user_name: string }>(page, '/api/admin/users', {
      method: 'POST',
      body: {
        user_name: `quality-${role}-${accountId}`,
        password,
        role: 'user',
      },
    })
    await addQualityProjectMember(page, projectId, user.id)
    return { ...user, password }
  }
  return {
    qa: await create('qa'),
    product: await create('product'),
    ui: await create('ui'),
  }
}

export async function addQualityProjectMember(
  page: Page,
  projectId: string,
  userId: number
): Promise<void> {
  await webApi(page, `/api/v1/cloud-projects/${projectId}/members`, {
    method: 'POST',
    body: { user_id: userId, role: 'Developer' },
  })
}

export async function removeQualityProjectMember(
  page: Page,
  projectId: string,
  userId: number
): Promise<void> {
  await webApi(page, `/api/v1/cloud-projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
  })
}

export function qualityWorkflow(
  engineerId: number,
  users: Record<'qa' | 'product' | 'ui', QualityUser>
) {
  const target = (userId: number) => [
    { assignee_type: 'user' as const, assignee_id: String(userId) },
  ]
  return {
    version: 1,
    definition_version: 1,
    stage_mode: 'dag' as const,
    advancement_policy: 'manual' as const,
    current_stage_id: 'implementation',
    feature_flags: { 'collab.enforceStageAssignee.v1': true },
    nodes: [
      { id: 'implementation', name: '开发实现', status: 'running' as const },
      {
        id: 'quality',
        name: '质量验收',
        status: 'blocked' as const,
        depends_on: ['implementation'],
        required_assignee_role: 'qa' as const,
      },
      {
        id: 'release',
        name: '发布上线',
        status: 'blocked' as const,
        depends_on: ['quality'],
      },
    ],
    assignee_roles: {
      engineering: target(engineerId),
      qa: target(users.qa.id),
      product: target(users.product.id),
      ui: target(users.ui.id),
      pmo: target(engineerId),
    },
  }
}

export async function configureQualityIssue(
  page: Page,
  projectId: string,
  issueId: string,
  prUrl: string,
  engineerId: number,
  workflow: ReturnType<typeof qualityWorkflow>
): Promise<QualityIssue> {
  const issuePath = `/api/v1/loop-items/${issueId}`
  const current = await webApi<QualityIssue>(page, issuePath)
  const saved = await webApi<QualityIssue>(page, issuePath, {
    method: 'PATCH',
    body: {
      version: current.version,
      description: `Quality flow evidence\n\n${prUrl}`,
      status: 'in_progress',
      assignee_user_id: engineerId,
      notify_assignee: false,
      tags: ['开发实现'],
      workflow,
    },
  })
  expect(saved.workflow.current_stage_id).toBe('implementation')
  expect(
    saved.badges?.some(badge => badge.icon === 'git-pull-request' && badge.url === prUrl)
  ).toBe(true)
  return saved
}

export async function createPollingGithubHook(
  page: Page,
  projectId: string,
  fixture: { apiBase: string; repository: string; webUrl: string },
  credentialRef: string
): Promise<QualityIncomingHook> {
  const hook = await webApi<QualityIncomingHook>(
    page,
    `/api/v1/cloud-projects/${projectId}/incoming-hooks`,
    {
      method: 'POST',
      body: {
        name: `Quality GitHub ${crypto.randomUUID()}`,
        source_type: 'github',
        collection_mode: 'poll',
        resource: {
          resource_type: 'repository',
          instance_url: fixture.apiBase,
          path: fixture.repository,
          url: fixture.webUrl,
        },
        poll_interval_seconds: 60,
        credential_ref: credentialRef,
      },
    }
  )
  expect(hook.collectionMode).toBe('poll')
  expect(hook.webhookUrl).toBeNull()
  return hook
}

export async function deleteQualityIncomingHook(
  page: Page,
  projectId: string,
  hookId: string
): Promise<void> {
  await webApi(page, `/api/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}`, {
    method: 'DELETE',
  })
}

export async function seedProjectEventConnection(
  userId: number,
  slug: string,
  token: string
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Quality handoff E2E requires the running service DATABASE_URL')
  }
  await execFileAsync(
    'uv',
    [
      'run',
      '--no-sync',
      'python',
      'tests/e2e/project_event_connector.py',
      'seed',
      String(userId),
      slug,
    ],
    {
      cwd: resolve(__dirname, '../../../backend'),
      env: { ...process.env, E2E_PROVIDER_TOKEN: token, PYTHONPATH: '.:..' },
      timeout: 20_000,
    }
  )
}

export async function removeProjectEventConnection(userId: number, slug: string): Promise<void> {
  if (!process.env.DATABASE_URL) return
  await execFileAsync(
    'uv',
    [
      'run',
      '--no-sync',
      'python',
      'tests/e2e/project_event_connector.py',
      'cleanup',
      String(userId),
      slug,
    ],
    {
      cwd: resolve(__dirname, '../../../backend'),
      env: { ...process.env, PYTHONPATH: '.:..' },
      timeout: 20_000,
    }
  )
}

export async function triggerProjectEventPolling(hookId: string): Promise<number> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Quality handoff E2E requires the running service DATABASE_URL')
  }
  const { stdout } = await execFileAsync(
    'uv',
    ['run', '--no-sync', 'python', 'tests/e2e/project_event_connector.py', 'trigger', hookId],
    {
      cwd: resolve(__dirname, '../../../backend'),
      env: { ...process.env, PYTHONPATH: '.:..' },
      timeout: 70_000,
    }
  )
  const result = JSON.parse(stdout.trim()) as { processed?: number }
  if (typeof result.processed !== 'number') {
    throw new Error('Project event polling did not return its processed count')
  }
  return result.processed
}

export async function loginQualityUser(
  request: APIRequestContext,
  user: QualityAccount
): Promise<string> {
  const user_name = user.user_name || user.username
  if (!user_name) throw new Error('Quality handoff E2E account has no username')
  const login = await createApiClient(request).login(user_name, user.password)
  expect(login.data?.access_token).toBeTruthy()
  return login.data!.access_token
}

export async function submitQualityReview(
  request: APIRequestContext,
  token: string,
  issueId: string,
  body: {
    version: number
    decision?: 'no_objection' | 'accepted' | 'changes_requested'
    evidence?: string[]
    idempotency_key: string
    pr_head_sha: string
  }
): Promise<{ status: number; body: QualityIssue | { detail?: unknown }; text: string }> {
  const response = await request.patch(`${API_BASE_URL}/api/v1/loop-items/${issueId}`, {
    headers: createBackendRequestHeaders(token),
    data: {
      version: body.version,
      quality_review: {
        decision: body.decision || 'no_objection',
        evidence: body.evidence || [`qa-e2e:${body.idempotency_key}`],
        idempotency_key: body.idempotency_key,
        pr_head_sha: body.pr_head_sha,
      },
    },
  })
  const text = await response.text()
  return {
    status: response.status(),
    body: text ? (JSON.parse(text) as QualityIssue | { detail?: unknown }) : {},
    text,
  }
}

export async function collaborationNotificationCounts(
  request: APIRequestContext,
  consumer: QualityAccount,
  issueId: string
): Promise<QualityNotificationCounts> {
  const token = await loginQualityUser(request, consumer)
  const response = await request.get(
    `${API_BASE_URL}/api/v1/wework-notifications?category=collaboration&limit=100`,
    { headers: createBackendRequestHeaders(token) }
  )
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { items: QualityNotification[] }
  const matching = body.items.filter(
    item => item.payload.itemId === issueId || item.payload.issueId === issueId
  )
  return {
    assignments: matching.filter(item => item.kind === 'assignment').length,
    total: matching.length,
  }
}

export async function issueCommentCount(page: Page, issueId: string): Promise<number> {
  const comments = await webApi<unknown[]>(page, `/api/v1/loop-items/${issueId}/comments`)
  return comments.length
}

export async function issueEventCount(page: Page, eventsPath: string): Promise<number> {
  return (await webApi<QualityIncomingEvent[]>(page, eventsPath)).length
}
