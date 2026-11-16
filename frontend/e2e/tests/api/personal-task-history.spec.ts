import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from '@playwright/test'

import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, type ApiClient } from '../../utils/api-client'

const execFileAsync = promisify(execFile)
const repository = resolve(__dirname, '../../../..')
type Account = { id: number; prefix: string; api: ApiClient }
type SeededHistory = {
  first_page: number[]
  second_page: number[]
  last_cursor_id: number | null
  last_visible_id: number | null
}
type HistoryPage = {
  items: Array<{ id: number }>
  next_cursor: string | null
  has_more: boolean
}

async function historyState<T>(account: Account, operation: 'seed' | 'cleanup', count = 10_005) {
  if (!process.env.DATABASE_URL) {
    throw new Error('Personal history E2E requires the isolated service DATABASE_URL')
  }
  const child = execFileAsync(
    'uv',
    ['run', '--no-sync', '--no-env-file', 'python', 'tests/e2e/personal_task_history_state.py'],
    {
      cwd: resolve(repository, 'backend'),
      env: { ...process.env, PYTHONPATH: '.:..' },
      encoding: 'utf8',
      timeout: 30_000,
    }
  )
  child.child.stdin!.end(
    JSON.stringify({ operation, count, prefix: account.prefix, user_id: account.id })
  )
  return JSON.parse((await child).stdout) as T
}

function cursor(id: number): string {
  // Keep the opaque wire shape while intentionally using an unrelated timestamp.
  return Buffer.from(JSON.stringify({ created_at: '2026-01-01T00:00:00', id })).toString(
    'base64url'
  )
}

// The existing api project in e2e-tests.yml starts the real Rust gateway and MySQL.
test('personal history follows IDs and cannot page beyond the newest 10000 tasks', async ({
  request,
}) => {
  const routes = readFileSync(resolve(repository, 'backend-rs/config/routes.toml'), 'utf8')
  expect(routes).toMatch(
    /^\[\[routes\]\]\s*\nmethods = \["GET"\]\s*\npath = "\/api\/tasks\/lite\/personal"/m
  )
  const admin = createApiClient(request)
  expect((await admin.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  const accounts: Account[] = []
  try {
    for (let index = 0; index < 2; index += 1) {
      const prefix = `e2e-personal-history-${randomUUID().slice(0, 8)}`
      const password = `E2e!${randomUUID()}`
      const created = await admin.post<{ id: number }>('/api/admin/users', {
        user_name: prefix,
        password,
        role: 'user',
        auth_source: 'password',
      })
      expect(created.status).toBe(201)
      const api = createApiClient(request)
      const account = { id: created.data!.id, prefix, api }
      accounts.push(account)
      expect((await api.login(prefix, password, 1)).status).toBe(200)
    }
    const owner = accounts[0]!
    const other = accounts[1]!
    const seeded = await historyState<SeededHistory>(owner, 'seed')
    const otherSeeded = await historyState<SeededHistory>(other, 'seed', 2)
    const readPage = async (account: Account, after?: string): Promise<HistoryPage> => {
      const query = new URLSearchParams({ limit: '100' })
      if (after) query.set('cursor', after)
      const response = await account.api.get<HistoryPage>(`/api/tasks/lite/personal?${query}`)
      expect(response.status, JSON.stringify(response.data)).toBe(200)
      return response.data!
    }
    const first = await readPage(owner)
    expect(first.items.map(task => task.id)).toEqual(seeded.first_page)
    expect(first.has_more).toBe(true)
    expect(first.next_cursor).not.toBeNull()
    const next = await readPage(owner, first.next_cursor!)
    expect(next.items.map(task => task.id)).toEqual(seeded.second_page)
    const last = await readPage(owner, cursor(seeded.last_cursor_id!))
    expect(last.items.map(task => task.id)).toEqual([seeded.last_visible_id])
    expect(last.has_more).toBe(false)
    expect(last.next_cursor).toBeNull()
    const exhausted = await readPage(owner, cursor(seeded.last_visible_id!))
    expect(exhausted).toMatchObject({ items: [], has_more: false, next_cursor: null })
    const isolated = await readPage(other)
    expect(isolated.items.slice(0, 2).map(task => task.id)).toEqual(otherSeeded.first_page)
    expect(isolated.items.some(task => seeded.first_page.includes(task.id))).toBe(false)
  } finally {
    const failures: unknown[] = []
    for (const account of accounts.reverse()) {
      try {
        const removed = await historyState<{ cleaned: boolean }>(account, 'cleanup')
        expect(removed.cleaned).toBe(true)
      } catch (error) {
        failures.push(error)
      }
      try {
        expect((await admin.delete(`/api/admin/users/${account.id}`)).status).toBe(204)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Personal history cleanup failed')
  }
})
