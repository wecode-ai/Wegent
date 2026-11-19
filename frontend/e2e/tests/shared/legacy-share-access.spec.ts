import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

type Fixture = {
  task_id: number
  team_id: number
  kb_id: number
  attachment_id: number
  unlinked_attachment_id: number
  tokens: { Task: string; TaskInvite: string; Team: string; KnowledgeBase: string }
  body: string
}

test.use({ storageState: { cookies: [], origins: [] } })

// Auto-discovered by the existing chromium CI project. No service is mocked.
test('legacy URLs require existing access while newly issued opaque shares stay public', async ({
  page,
  request,
}) => {
  const prefix = `e2e-legacy-share-${randomUUID()}`
  const state = <T>(operation: string): T => {
    if (!process.env.DATABASE_URL) throw new Error('Share E2E requires isolated DATABASE_URL')
    return JSON.parse(
      execFileSync('uv', ['run', '--no-sync', 'python', 'tests/e2e/legacy_share_state.py'], {
        cwd: resolve(process.cwd(), '../backend'),
        env: { ...process.env, PYTHONPATH: '.:..' },
        encoding: 'utf8',
        timeout: 30_000,
        input: JSON.stringify({
          operation,
          prefix,
          owner: ADMIN_USER.username,
          viewer: REGULAR_USER.username,
        }),
      })
    ) as T
  }
  const owner = createApiClient(request)
  const viewer = createApiClient(request)
  const anonymous = createApiClient(request)
  const ownerLogin = await owner.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  const viewerLogin = await viewer.login(REGULAR_USER.username, REGULAR_USER.password, 1)
  expect(ownerLogin.status).toBe(200)
  expect(viewerLogin.status).toBe(200)
  const fixture = state<Fixture>('seed')
  const taskUrl = `/shared/task?token=${encodeURIComponent(fixture.tokens.Task)}`
  const reads = [
    `/api/tasks/share/public?token=${encodeURIComponent(fixture.tokens.Task)}`,
    `/api/share/info?share_token=${encodeURIComponent(fixture.tokens.Team)}`,
    `/api/share/public/knowledge?token=${encodeURIComponent(fixture.tokens.KnowledgeBase)}`,
    `/api/attachments/${fixture.attachment_id}?share_token=${encodeURIComponent(fixture.tokens.Task)}`,
    `/api/tasks/invite/info?token=${encodeURIComponent(fixture.tokens.TaskInvite)}`,
  ]
  try {
    for (const url of reads) {
      expect((await anonymous.get(url)).status).toBe(401)
      expect((await viewer.get(url)).status).toBe(403)
      expect((await owner.get(url)).status).toBe(200)
    }
    // Storage compatibility never turns old-writer rows into bearer authority.
    state('old-writer')
    for (const url of reads) {
      expect((await anonymous.get(url)).status).toBe(401)
      expect((await viewer.get(url)).status).toBe(403)
      expect((await owner.get(url)).status).toBe(200)
    }
    expect((await anonymous.get(`/api/tasks/share/public?token=${prefix}-unrecorded`)).status).toBe(
      400
    )
    expect(
      (await anonymous.get(`/api/share/public/knowledge/redirect?kb_id=${fixture.kb_id}`)).status
    ).toBe(401)
    expect(
      (await viewer.get(`/api/share/public/knowledge/redirect?kb_id=${fixture.kb_id}`)).status
    ).toBe(403)
    expect(
      (await viewer.post('/api/share/join', { share_token: fixture.tokens.KnowledgeBase })).status
    ).toBe(403)
    expect(
      (
        await viewer.post(
          `/api/tasks/invite/join?token=${encodeURIComponent(fixture.tokens.TaskInvite)}`
        )
      ).status
    ).toBe(403)

    await page.goto(taskUrl)
    await expect(page.getByTestId('shared-task-access-action')).toBeVisible()
    await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
    await page.getByTestId('shared-task-access-action').click()
    await expect(page).toHaveURL(new RegExp(`/login\\?redirect=`))
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(taskUrl)

    state('approved')
    for (const url of reads) expect((await viewer.get(url)).status).toBe(200)
    const existingMember = await viewer.post<{ already_member: boolean }>(
      `/api/tasks/invite/join?token=${encodeURIComponent(fixture.tokens.TaskInvite)}`
    )
    expect(existingMember.status).toBe(200)
    expect(existingMember.data?.already_member).toBe(true)
    await page.evaluate(
      token => localStorage.setItem('auth_token', token),
      viewerLogin.data!.access_token
    )
    await page.goto(taskUrl)
    await expect(page.getByRole('heading', { name: prefix, exact: true })).toBeVisible()
    await expect(page.getByText(fixture.body, { exact: true })).toBeVisible()

    const taskShare = await owner.post<{ share_token: string }>(
      `/api/tasks/${fixture.task_id}/share`
    )
    expect(taskShare.status).toBe(200)
    expect(taskShare.data!.share_token).not.toBe(fixture.tokens.Task)
    const opaqueTask = await anonymous.get<{ subtasks: Array<{ prompt: string }> }>(
      `/api/tasks/share/public?token=${encodeURIComponent(taskShare.data!.share_token)}`
    )
    expect(opaqueTask.status).toBe(200)
    expect(opaqueTask.data?.subtasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ prompt: fixture.body })])
    )
    expect(
      (
        await anonymous.get(
          `/api/attachments/${fixture.attachment_id}?share_token=${encodeURIComponent(taskShare.data!.share_token)}`
        )
      ).status
    ).toBe(200)
    expect(
      (
        await anonymous.get(
          `/api/attachments/${fixture.unlinked_attachment_id}?share_token=${encodeURIComponent(taskShare.data!.share_token)}`
        )
      ).status
    ).toBe(403)

    const newlyIssued = await owner.post<{ share_token: string }>(
      `/api/share/KnowledgeBase/${fixture.kb_id}/link`,
      { config: { require_approval: false, default_role: 'Reporter' } }
    )
    expect(newlyIssued.status).toBe(200)
    expect(newlyIssued.data!.share_token).not.toBe(fixture.tokens.KnowledgeBase)
    expect(
      (
        await anonymous.get(
          `/api/share/public/knowledge?token=${encodeURIComponent(newlyIssued.data!.share_token)}`
        )
      ).status
    ).toBe(200)
    const memberLocator = await viewer.get<{ share_token: string }>(
      `/api/share/public/knowledge/redirect?kb_id=${fixture.kb_id}`
    )
    expect(memberLocator.data?.share_token).toBe(fixture.tokens.KnowledgeBase)
    expect((await owner.get(reads[2])).status).toBe(200)

    state('rejected')
    for (const url of reads) expect((await viewer.get(url)).status).toBe(403)
    await page.goto(taskUrl)
    await expect(page.getByTestId('shared-task-access-action')).toBeVisible()
    await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
    const unifiedTask = await owner.post<{ share_token: string }>(
      `/api/share/Task/${fixture.task_id}/link`,
      { config: { require_approval: true, default_role: 'Reporter' } }
    )
    expect(unifiedTask.status).toBe(200)
    expect(unifiedTask.data!.share_token).not.toBe(taskShare.data!.share_token)
    const unifiedToken = encodeURIComponent(unifiedTask.data!.share_token)
    expect((await anonymous.get(`/api/tasks/share/public?token=${unifiedToken}`)).status).toBe(400)
    expect(
      (await anonymous.get(`/api/attachments/${fixture.attachment_id}?share_token=${unifiedToken}`))
        .status
    ).toBe(403)
    expect(
      (
        await viewer.post('/api/tasks/share/join', {
          share_token: unifiedTask.data!.share_token,
          team_id: fixture.team_id,
        })
      ).status
    ).toBe(400)
    expect(
      (await viewer.post('/api/share/join', { share_token: taskShare.data!.share_token })).status
    ).toBe(400)
    const pending = await viewer.post<{ status: string }>('/api/share/join', {
      share_token: unifiedTask.data!.share_token,
    })
    expect(pending.status).toBe(200)
    expect(pending.data?.status).toBe('pending')
    expect(
      (
        await anonymous.get(
          `/api/tasks/share/public?token=${encodeURIComponent(taskShare.data!.share_token)}`
        )
      ).status
    ).toBe(200)
    state('expired')
    for (const url of reads) expect([400, 403, 404]).toContain((await owner.get(url)).status)
    state('revoked')
    for (const url of reads) expect([400, 403, 404]).toContain((await owner.get(url)).status)
  } finally {
    state('cleanup')
  }
})
