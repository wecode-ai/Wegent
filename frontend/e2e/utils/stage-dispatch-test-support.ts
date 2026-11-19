// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'

const execFileAsync = promisify(execFile)

export interface StageDispatchFixture {
  dispatch_id: string
  manager_agent_id: string
  manager_runtime_task_id: string
}

export interface StageIssueSnapshot {
  version: number
  assignee_user_id: number | null
  assignment_history_length: number
  executions: number
  messages: number
  notifications: number
  comments: number
}

async function runFixture(args: string[]): Promise<string> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Stage-assignee E2E requires the running service DATABASE_URL')
  }
  const { stdout } = await execFileAsync(
    'uv',
    ['run', '--no-sync', 'python', 'tests/e2e/collaboration_stage_fixture.py', ...args],
    {
      cwd: resolve(__dirname, '../../../backend'),
      env: { ...process.env, PYTHONPATH: '.:..' },
      timeout: 20_000,
    }
  )
  return stdout.trim()
}

export async function seedStageDispatch(
  issueId: string,
  targetUserId: number
): Promise<StageDispatchFixture> {
  return JSON.parse(
    await runFixture(['seed', issueId, String(targetUserId)])
  ) as StageDispatchFixture
}

export async function snapshotStageIssue(issueId: string): Promise<StageIssueSnapshot> {
  return JSON.parse(await runFixture(['snapshot', issueId])) as StageIssueSnapshot
}

export async function cleanupStageDispatch(issueId: string, managerId: string): Promise<void> {
  await runFixture(['cleanup', issueId, managerId])
}

export async function submitWorkflowPlan(
  page: Page,
  projectId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: { detail?: unknown } }> {
  return page.evaluate(
    async ({ path, payload }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return {
        status: response.status,
        body: (await response.json()) as { detail?: unknown },
      }
    },
    {
      path: `/api/v1/cloud-projects/${projectId}/executions/batch`,
      payload: body,
    }
  )
}
