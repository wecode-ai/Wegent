import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'

type Fixture = {
  task_id: number
  attachment_id: number
  tokens: { Task: string }
  body: string
}

test.use({ storageState: { cookies: [], origins: [] } })

// Uses the existing isolated MySQL fixture and the CI-discovered chromium suite.
for (const requireApproval of [true, false]) {
  test(`generated Task access links preserve permissions (approval=${requireApproval})`, async ({
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
    const setBrowserSession = async (token: string) => {
      const expiry = getJwtExpiryMs(token)
      expect(expiry).not.toBeNull()
      const storage = buildStorageState(page.url(), token, expiry)
      await page.context().addCookies(storage.cookies)
      await page.evaluate(entries => {
        for (const { name, value } of entries) localStorage.setItem(name, value)
      }, storage.origins[0].localStorage)
    }
    const ownerLogin = await owner.login(ADMIN_USER.username, ADMIN_USER.password, 1)
    expect(ownerLogin.status).toBe(200)
    const login = await viewer.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(login.status).toBe(200)
    const fixture = state<Fixture>('seed')
    try {
      const issued = await owner.post<{ share_url: string; share_token: string }>(
        `/api/share/Task/${fixture.task_id}/link`,
        { config: { require_approval: requireApproval, default_role: 'Reporter' } }
      )
      expect(issued.status).toBe(200)
      const url = new URL(issued.data!.share_url)
      expect(url.pathname).toBe('/shared/task/access')
      const target = `${url.pathname}${url.search}`
      const publicRead = `/api/tasks/share/public?token=${encodeURIComponent(issued.data!.share_token)}`
      const legacyRead = `/api/tasks/share/public?token=${encodeURIComponent(fixture.tokens.Task)}`
      expect((await anonymous.get(publicRead)).status).toBe(400)
      expect((await viewer.get(legacyRead)).status).toBe(403)
      await page.goto(target)
      await expect(page.getByRole('heading', { name: prefix, exact: true })).toBeVisible()
      await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
      await page.getByTestId('task-access-login').click()
      await expect(page).toHaveURL(/\/login\?redirect=/)
      expect(new URL(page.url()).searchParams.get('redirect')).toBe(target)

      await setBrowserSession(login.data!.access_token)
      await page.goto(target)
      const joined = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/share/join' &&
          response.request().method() === 'POST'
      )
      await page.getByTestId('task-access-request').click()
      const response = await joined
      expect(response.status()).toBe(200)
      const member = await response.json()
      expect(member.status).toBe(requireApproval ? 'pending' : 'approved')
      if (requireApproval) {
        await expect(page.getByTestId('task-access-pending')).toBeVisible()
        await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
        expect((await viewer.get(legacyRead)).status).toBe(403)
        expect(
          (
            await viewer.get(
              `/api/attachments/${fixture.attachment_id}?share_token=${encodeURIComponent(issued.data!.share_token)}`
            )
          ).status
        ).toBe(403)

        const approval = await owner.post(
          `/api/share/Task/${fixture.task_id}/requests/${member.member_id}/review`,
          { approved: true, role: 'Reporter' }
        )
        expect(approval.status).toBe(200)
        await page.getByTestId('task-access-request').click()
      }
      await expect(page).toHaveURL(new RegExp(`/chat\\?taskId=${fixture.task_id}$`))
      expect((await viewer.get(`/api/tasks/${fixture.task_id}`)).status).toBe(200)
      // Approval does not convert the metadata token into a public-read bearer.
      expect((await anonymous.get(publicRead)).status).toBe(400)
      expect((await anonymous.get(legacyRead)).status).toBe(401)
      expect((await viewer.get(legacyRead)).status).toBe(200)
      await page.goto(`/shared/task?token=${encodeURIComponent(fixture.tokens.Task)}`)
      await expect(page.getByText(fixture.body, { exact: true })).toBeVisible()
      await setBrowserSession(ownerLogin.data!.access_token)
      await page.goto(target)
      await page.getByTestId('task-access-request').click()
      await expect(page).toHaveURL(new RegExp(`/chat\\?taskId=${fixture.task_id}$`))
      await page.goto(`/shared/task?token=${encodeURIComponent(fixture.tokens.Task)}`)
      await expect(page.getByText(fixture.body, { exact: true })).toBeVisible()
      const sessionTab = await page.context().newPage()
      try {
        await sessionTab.goto(`/shared/task?token=${prefix}-unrecorded`)
        const logoutFromOtherTab = async () => {
          await page.context().clearCookies({ name: 'auth_token' })
          await sessionTab.evaluate(() => {
            localStorage.removeItem('auth_token')
            localStorage.removeItem('auth_token_expire')
          })
        }
        // A native cross-tab storage event must clear the already rendered body.
        await logoutFromOtherTab()
        await expect(page.getByTestId('shared-task-access-action')).toBeVisible()
        await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
        await page.getByTestId('shared-task-access-action').click()
        await expect(page).toHaveURL(/\/login\?redirect=/)

        await setBrowserSession(ownerLogin.data!.access_token)
        await page.goto(target)
        await expect(page.getByTestId('task-access-request')).toBeVisible()
        await logoutFromOtherTab()
        await expect(page.getByTestId('task-access-login')).toBeVisible()
        await expect(page.getByTestId('task-access-request')).toHaveCount(0)
      } finally {
        await sessionTab.close()
      }
      await setBrowserSession(ownerLogin.data!.access_token)
      await page.goto(`/shared/task?token=${encodeURIComponent(fixture.tokens.Task)}`)
      await expect(page.getByText(fixture.body, { exact: true })).toBeVisible()
      // Exercise a client-side link change rather than resetting the page with goto.
      await page.evaluate(next => {
        window.history.pushState(null, '', next)
      }, `/shared/task?token=${prefix}-unrecorded`)
      await expect(page.getByTestId('shared-task-access-action')).toBeVisible()
      await expect(page.getByText(fixture.body, { exact: true })).toHaveCount(0)
    } finally {
      state('cleanup')
    }
  })
}
