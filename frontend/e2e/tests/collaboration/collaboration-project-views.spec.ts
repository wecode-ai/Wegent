// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

interface ScheduledProject {
  path: string
  issueId: string
  title: string
}

const projectTest = test.extend<{ scheduledProject: ScheduledProject }>({
  scheduledProject: async ({ page, request }, use) => {
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    const suffix = crypto.randomUUID()
    const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Project views ${suffix}` },
    })
    let project: Resource | undefined
    try {
      project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
        method: 'POST',
        body: {
          workspace_id: workspace.id,
          name: `Schedule ${suffix}`,
          task_provider: 'local',
          visibility: 'private',
        },
      })
      const users = await webApi<{ users: Array<{ id: number; user_name: string }> }>(
        page,
        `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
      )
      const member = users.users.find(user => user.user_name === REGULAR_USER.username)
      expect(member, 'Global setup must provision the regular E2E user').toBeDefined()
      await webApi(page, `/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: { user_id: member!.id, role: 'Developer' },
      })
      const memberApi = createApiClient(request)
      const login = await memberApi.login(REGULAR_USER.username, REGULAR_USER.password, 1)
      expect(login.status).toBe(200)
      const today = new Date()
      today.setHours(12, 0, 0, 0)
      const title = `Scheduled Issue ${suffix}`
      const created = await memberApi.post<Resource>(
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        {
          title,
          description: 'Created by another member to verify an unread board card.',
          status: 'pending',
          priority: 'none',
          tags: [],
          start_at: today.toISOString(),
          due_at: today.toISOString(),
        }
      )
      expect(created.status).toBe(201)
      expect(created.data?.id).toBeTruthy()
      await use({
        path: `/collaboration/workspaces/${workspace.id}/projects/${project.id}`,
        issueId: created.data!.id,
        title,
      })
    } finally {
      if (project) {
        const current = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}`)
        await webApi(page, `/api/v1/cloud-projects/${project.id}?version=${current.version}`, {
          method: 'DELETE',
        })
      }
      const current = await webApi<Resource>(page, `/api/v1/workspaces/${workspace.id}`)
      await webApi(page, `/api/v1/workspaces/${workspace.id}?version=${current.version}`, {
        method: 'DELETE',
      })
    }
  },
})

projectTest.setTimeout(120_000)

projectTest(
  'expands linked task history in a bounded scroll area',
  async ({ page, scheduledProject: { path, issueId } }) => {
    // Persist historical session references through the real binding API.
    for (let index = 0; index < 9; index += 1) {
      await webApi(page, `/api/v1/loop-items/${issueId}/tasks`, {
        method: 'POST',
        body: {
          deviceId: 'archived-history-device',
          taskId: `${issueId}-history-${index}`,
          taskTitle: `Historical task ${index + 1}`,
        },
      })
    }

    await page.goto(path)
    await page.getByTestId(`cloud-todo-card-${issueId}`).click()
    const section = page.getByTestId('cloud-todo-tasks')
    const list = section.getByTestId('cloud-todo-task-list')
    const toggle = section.getByTestId('cloud-todo-toggle-tasks')
    await expect(section.getByTestId('cloud-todo-execution-task-count')).toHaveText('9')
    await expect(list.getByRole('button')).toHaveCount(2)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(list.getByRole('button')).toHaveCount(9)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const geometry = () =>
      list.evaluate(element => ({
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }))
    const before = await geometry()
    expect(before.height).toBeGreaterThan(0)
    expect(before.height).toBeLessThanOrEqual(280)
    expect(before.contentHeight).toBeGreaterThan(before.height)
    const last = list.getByRole('button').last()
    await list.hover()
    await page.mouse.wheel(0, before.contentHeight)
    await expect.poll(async () => (await geometry()).scrollTop).toBeGreaterThan(0)
    await expect(last).toBeInViewport()
    expect((await geometry()).height).toBe(before.height)
    await expect(toggle).toBeInViewport()

    await toggle.click()
    await expect(list.getByRole('button')).toHaveCount(2)
    await toggle.click()
    expect((await geometry()).scrollTop).toBe(0)
  }
)

projectTest(
  'sorts lanes independently with compound rules and restores choices after reload',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const createIssue = async (priority: 'high' | 'urgent', status = 'pending') => {
      // The real database stores creation timestamps to second precision.
      await new Promise(resolve => setTimeout(resolve, 1_100))
      return webApi<Resource & { created_at: string }>(
        page,
        `/api/v1/cloud-projects/${projectId}/loop-items`,
        {
          method: 'POST',
          body: { title: `Sort ${priority}`, status, priority },
        }
      )
    }
    const high = await createIssue('high')
    const urgent = await createIssue('urgent')
    const newerHigh = await createIssue('high')
    expect(Date.parse(newerHigh.created_at)).toBeGreaterThan(Date.parse(high.created_at))
    const completedHigh = await createIssue('high', 'completed')
    const completedUrgent = await createIssue('urgent', 'completed')
    // Equal-priority cards deliberately have the opposite manual and time order.
    const manualOrder = [issueId, newerHigh.id, high.id, urgent.id]
    await webApi(page, `/api/v1/cloud-projects/${projectId}/loop-items/reorder`, {
      method: 'POST',
      body: { parent_id: null, status: 'pending', item_ids: manualOrder },
    })

    await page.goto(path)
    const sort = page.getByTestId('cloud-board-sort-by-pending')
    const completedSort = page.getByTestId('cloud-board-sort-by-completed')
    const assertOrder = async (lane: string, ids: string[]) => {
      const cards = page
        .getByTestId(`cloud-todo-column-${lane}`)
        .locator('article[data-testid^="collaboration-issue-"]')
      await expect(cards).toHaveCount(ids.length)
      for (const [index, id] of ids.entries()) {
        await expect(cards.nth(index)).toHaveAttribute('data-testid', `collaboration-issue-${id}`)
      }
    }

    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc')
    await assertOrder('pending', [urgent.id, newerHigh.id, high.id, issueId])
    await assertOrder('completed', [completedUrgent.id, completedHigh.id])
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-manual').click()
    await sort.click()
    await completedSort.click()
    await page.getByTestId('cloud-board-sort-by-completed-rule-0-mode').click()
    await page.getByTestId('cloud-board-sort-by-completed-rule-0-mode-created-asc').click()
    await completedSort.click()
    await assertOrder('pending', manualOrder)
    await assertOrder('completed', [completedHigh.id, completedUrgent.id])
    await page.reload()
    await expect(sort).toHaveAttribute('data-sort-rules', 'manual')
    await expect(completedSort).toHaveAttribute('data-sort-rules', 'created-asc')
    await assertOrder('pending', manualOrder)
    await assertOrder('completed', [completedHigh.id, completedUrgent.id])
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-add').click()
    await page.getByTestId('cloud-board-sort-by-pending-add').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode-created-asc').click()
    await sort.click()
    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await assertOrder('pending', [urgent.id, high.id, newerHigh.id, issueId])
    await page.reload()
    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await assertOrder('pending', [urgent.id, high.id, newerHigh.id, issueId])
    await expect(completedSort).toHaveAttribute('data-sort-rules', 'created-asc')

    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-up').click()
    await sort.click()
    await expect(sort).toHaveAttribute('data-sort-rules', 'created-asc,priority-desc')
    await assertOrder('pending', [issueId, high.id, urgent.id, newerHigh.id])

    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-0-down').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode').click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-mode-created-desc').click()
    await sort.click()
    await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-desc')
    await assertOrder('pending', [urgent.id, newerHigh.id, high.id, issueId])
    await expect(completedSort).toHaveAttribute('data-sort-rules', 'created-asc')
    const updatedAsc = [newerHigh.id, issueId, urgent.id, high.id]
    for (const id of updatedAsc) {
      await new Promise(resolve => setTimeout(resolve, 1_100))
      const current = await webApi<Resource>(page, `/api/v1/loop-items/${id}`)
      await webApi(page, `/api/v1/loop-items/${id}`, {
        method: 'PATCH',
        body: { version: current.version, description: `Updated ${id}` },
      })
    }
    await page.reload()
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-rule-1-remove').click()
    await sort.click()
    const createdAsc = [issueId, high.id, urgent.id, newerHigh.id]
    for (const [mode, expected] of [
      ['priority-asc', [issueId, newerHigh.id, high.id, urgent.id]],
      ['priority-desc', [urgent.id, newerHigh.id, high.id, issueId]],
      ['created-asc', createdAsc],
      ['created-desc', [...createdAsc].reverse()],
      ['updated-asc', updatedAsc],
      ['updated-desc', [...updatedAsc].reverse()],
    ] as const) {
      await sort.click()
      await page.getByTestId('cloud-board-sort-by-pending-rule-0-mode').click()
      await page.getByTestId(`cloud-board-sort-by-pending-rule-0-mode-${mode}`).click()
      await sort.click()
      await expect(sort).toHaveAttribute('data-sort-rules', mode)
      await assertOrder('pending', [...expected])
    }
  }
)

for (const hiddenSiblings of [false, true])
  projectTest(
    `keeps three committed sibling positions through a failed snapshot refresh and recovery (hidden=${hiddenSiblings})`,
    async ({ page, scheduledProject: { path, issueId } }) => {
      const projectId = path.split('/').at(-1)!
      const create = async (title: string, securityLevel: 'open' | 'related' = 'open') => {
        const created = await webApi<Resource>(
          page,
          `/api/v1/cloud-projects/${projectId}/loop-items`,
          {
            method: 'POST',
            body: { title, priority: 'high', status: 'pending' },
          }
        )
        return securityLevel === 'related'
          ? webApi<Resource>(page, `/api/v1/loop-items/${created.id}`, {
              method: 'PATCH',
              body: { version: created.version, security_level: securityLevel },
            })
          : created
      }
      const second = await create('Recovery B')
      const third = await create('Recovery C')
      const hidden = hiddenSiblings
        ? [await create('Hidden first', 'related'), await create('Hidden second', 'related')]
        : []
      const initialIds = hiddenSiblings
        ? [issueId, hidden[0].id, second.id, hidden[1].id, third.id]
        : [issueId, second.id, third.id]
      await webApi(page, `/api/v1/cloud-projects/${projectId}/loop-items/reorder`, {
        method: 'POST',
        body: { parent_id: null, status: null, item_ids: initialIds },
      })
      try {
        if (hiddenSiblings) {
          await switchProjectAccount(page, path, REGULAR_USER.username, REGULAR_USER.password)
          expect((await webApi<{ role: string }>(page, '/api/users/me')).role).toBe('user')
          expect(
            (await webApi<{ access_role: string }>(page, `/api/v1/cloud-projects/${projectId}`))
              .access_role
          ).toBe('Developer')
        }
        await page.goto(path)
        const sort = page.getByTestId('cloud-board-sort-by-pending')
        await sort.click()
        await page.getByTestId('cloud-board-sort-by-pending-manual').click()
        await sort.click()
        const cards = page
          .getByTestId('cloud-todo-column-pending')
          .locator('article[data-testid^="collaboration-issue-"]')
        const expectOrder = async (ids = [second.id, issueId, third.id]) => {
          await expect(cards).toHaveCount(3)
          for (const [index, id] of ids.entries())
            await expect(cards.nth(index)).toHaveAttribute(
              'data-testid',
              `collaboration-issue-${id}`
            )
          for (const item of hidden)
            await expect(page.getByTestId(`collaboration-issue-${item.id}`)).toHaveCount(0)
        }
        await expectOrder([issueId, second.id, third.id])
        const readSnapshot = () =>
          webApi<{ items: Array<Resource & { sort_order: number }> }>(
            page,
            `/api/v1/cloud-projects/${projectId}/board-snapshot`
          )
        const initial = (await readSnapshot()).items.sort((a, b) => a.sort_order - b.sort_order)
        expect(initial.map(item => item.id)).toEqual([issueId, second.id, third.id])
        expect(initial.map(item => item.sort_order)).toEqual(hiddenSiblings ? [0, 2, 4] : [0, 1, 2])
        const snapshotUrl = `**/api/v1/cloud-projects/${projectId}/board-snapshot`
        let droppedSnapshots = 0
        await page.route(snapshotUrl, async route => {
          // Fetch from the real backend before interrupting response delivery.
          const response = await route.fetch()
          expect(response.ok()).toBe(true)
          droppedSnapshots += 1
          await route.abort('failed')
        })
        try {
          const saved = page.waitForResponse(
            response =>
              response.request().method() === 'PATCH' &&
              response.url().endsWith(`/loop-items/${issueId}`)
          )
          await dragBefore(page, 'pending', issueId, 'pending', third.id)
          const response = await saved
          expect(response.ok()).toBe(true)
          expect((await response.json()).sort_order).toBe(hiddenSiblings ? 3 : 1)
          await expect(page.getByTestId('collaboration-error')).toHaveText(/load|加载/i)
          expect(droppedSnapshots).toBeGreaterThan(0)
          await expectOrder()
        } finally {
          await page.unroute(snapshotUrl)
        }
        const snapshot = await readSnapshot()
        expect(
          snapshot.items.sort((a, b) => a.sort_order - b.sort_order).map(item => item.id)
        ).toEqual([second.id, issueId, third.id])
        await page.reload()
        await expectOrder()
        await expect(page.getByTestId('collaboration-error')).toHaveCount(0)
      } finally {
        if (hiddenSiblings)
          await switchProjectAccount(page, path, ADMIN_USER.username, ADMIN_USER.password)
      }
      if (hiddenSiblings) {
        const all = await webApi<{ items: Array<Resource & { sort_order: number }> }>(
          page,
          `/api/v1/cloud-projects/${projectId}/board-snapshot`
        )
        expect(all.items.sort((a, b) => a.sort_order - b.sort_order).map(item => item.id)).toEqual([
          hidden[0].id,
          second.id,
          hidden[1].id,
          issueId,
          third.id,
        ])
      }
    }
  )

async function switchProjectAccount(page: Page, path: string, username: string, password: string) {
  await page.goto('/settings')
  const toggle = page.getByTestId('task-sidebar').getByTestId('user-floating-menu-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('task-sidebar').getByTestId('user-floating-menu-logout').click()
  await page.waitForURL(/\/login/)
  await page.locator('input[name="user_name"]').fill(username)
  await page.locator('input[name="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(url => !url.pathname.includes('/login'))
  await page.goto(path)
}

async function dragBefore(
  page: Page,
  sourceLane: string,
  id: string,
  lane: string,
  beforeId: string | null
) {
  const source = page
    .getByTestId(`cloud-todo-column-${sourceLane}`)
    .getByTestId(`cloud-todo-card-${id}`)
  const target = beforeId
    ? page.getByTestId(`cloud-todo-column-${lane}`).getByTestId(`collaboration-issue-${beforeId}`)
    : page.getByTestId(`cloud-todo-column-dropzone-${lane}-content`)
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + 20, from.y + 20)
  await page.mouse.down()
  try {
    await page.mouse.move(from.x + 30, from.y + 20)
    await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    const to = (await target.boundingBox())!
    await page.mouse.move(
      beforeId ? to.x + to.width / 2 : to.x + 2,
      beforeId ? to.y + 10 : to.y + to.height - 2,
      { steps: 10 }
    )
  } finally {
    await page.mouse.up()
  }
  await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)
}

for (const groupBy of ['priority', 'assignee', 'tag'] as const) {
  projectTest(
    `saves manual ${groupBy} lane order across statuses and reloads`,
    async ({ page, scheduledProject: { path, issueId } }) => {
      const projectId = path.split('/').at(-1)!
      const project = await webApi<Resource & { current_user_id: number }>(
        page,
        `/api/v1/cloud-projects/${projectId}`
      )
      const create = async (
        title: string,
        extra: {
          status?: string
          priority?: string
          tags?: string[]
          assignee_user_id?: number
        } = {}
      ) => {
        const created = await webApi<Resource>(
          page,
          `/api/v1/cloud-projects/${projectId}/loop-items`,
          {
            method: 'POST',
            body: {
              title,
              priority: 'high',
              status: 'pending',
              tags: ['backend', 'shared'],
              ...extra,
            },
          }
        )
        // Creation assigns the creator by default; initialize the intended lane explicitly.
        return webApi<Resource>(page, `/api/v1/loop-items/${created.id}`, {
          method: 'PATCH',
          body: { version: created.version, assignee_user_id: extra.assignee_user_id ?? null },
        })
      }
      const first = await create('First')
      const second = await create('Second', { status: 'completed' })
      const outside = await create('Outside', {
        priority: 'low',
        tags: ['other'],
        assignee_user_id: project.current_user_id,
      })
      const snapshot = () =>
        webApi<{
          items: Array<
            Resource & {
              sort_order: number
              status: string
              tags: string[]
              assignee_user_id: number | null
            }
          >
        }>(page, `/api/v1/cloud-projects/${projectId}/board-snapshot`)
      await webApi(page, `/api/v1/cloud-projects/${projectId}/loop-items/reorder`, {
        method: 'POST',
        body: {
          parent_id: null,
          status: null,
          item_ids: [issueId, first.id, second.id, outside.id],
        },
      })
      await page.goto(path)
      await page.getByTestId('cloud-board-group-by').click()
      await page.getByTestId(`cloud-board-group-option-${groupBy}`).click()
      const lane =
        groupBy === 'priority'
          ? 'priority-high'
          : groupBy === 'assignee'
            ? 'assignee-unassigned'
            : 'tag-shared'
      const sourceLane =
        groupBy === 'priority'
          ? 'priority-low'
          : groupBy === 'assignee'
            ? `assignee-${project.current_user_id}`
            : 'tag-other'
      const sort = page.getByTestId(`cloud-board-sort-by-${lane}`)
      const assertOrder = async (ids: string[]) => {
        const cards = page
          .getByTestId(`cloud-todo-column-${lane}`)
          .locator('article[data-testid^="collaboration-issue-"]')
        await expect(cards).toHaveCount(ids.length)
        for (const [index, id] of ids.entries())
          await expect(cards.nth(index)).toHaveAttribute('data-testid', `collaboration-issue-${id}`)
      }
      await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc')
      const before = await snapshot()
      await dragBefore(page, lane, second.id, lane, first.id)
      await assertOrder([first.id, second.id])
      expect(
        (await snapshot()).items.map(({ id, version, sort_order }) => ({ id, version, sort_order }))
      ).toEqual(before.items.map(({ id, version, sort_order }) => ({ id, version, sort_order })))
      await sort.click()
      await page.getByTestId(`cloud-board-sort-by-${lane}-manual`).click()
      await sort.click()
      const reorder = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/loop-items/${second.id}`)
      )
      await dragBefore(page, lane, second.id, lane, first.id)
      expect((await reorder).ok()).toBe(true)
      await assertOrder([second.id, first.id])
      await page.reload()
      await expect(sort).toHaveAttribute('data-sort-rules', 'manual')
      await assertOrder([second.id, first.id])
      const crossReorder = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/loop-items/${outside.id}`)
      )
      await dragBefore(page, sourceLane, outside.id, lane, first.id)
      expect((await crossReorder).ok()).toBe(true)
      await assertOrder([second.id, outside.id, first.id])
      await page.reload()
      await assertOrder([second.id, outside.id, first.id])
      const saved = (await snapshot()).items
      expect(saved.find(item => item.id === second.id)).toMatchObject({
        status: 'completed',
        tags: ['backend', 'shared'],
        assignee_user_id: null,
      })
      expect(saved.find(item => item.id === first.id)?.status).toBe('pending')
      // Reorder through a status projection, including the blank lane tail, then
      // return to the original grouping and compare with the persisted global order.
      await page.getByTestId('cloud-board-group-by').click()
      await page.getByTestId('cloud-board-group-option-status').click()
      const pendingSort = page.getByTestId('cloud-board-sort-by-pending')
      await pendingSort.click()
      await page.getByTestId('cloud-board-sort-by-pending-manual').click()
      await pendingSort.click()
      await dragBefore(page, 'pending', first.id, 'pending', outside.id)
      await expect
        .poll(async () => {
          const items = (await snapshot()).items
          return (
            items.find(item => item.id === first.id)!.sort_order <
            items.find(item => item.id === outside.id)!.sort_order
          )
        })
        .toBe(true)
      await dragBefore(page, 'pending', first.id, 'pending', null)
      await expect
        .poll(async () => {
          const pending = (await snapshot()).items
            .filter(item => item.status === 'pending')
            .sort((a, b) => a.sort_order - b.sort_order)
          return pending.at(-1)?.id
        })
        .toBe(first.id)
      const canonical = (await snapshot()).items.sort((a, b) => a.sort_order - b.sort_order)
      expect(new Set(canonical.map(item => item.sort_order)).size).toBe(canonical.length)
      const expected = canonical
        .filter(item => [first.id, second.id, outside.id].includes(item.id))
        .map(item => item.id)
      const groupingSaved = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/cloud-projects/${projectId}`) &&
          response.ok()
      )
      await page.getByTestId('cloud-board-group-by').click()
      await page.getByTestId(`cloud-board-group-option-${groupBy}`).click()
      expect((await groupingSaved).ok()).toBe(true)
      await assertOrder(expected)
      await page.reload()
      await assertOrder(expected)
    }
  )
}

projectTest(
  'keeps independent lane changes from two tabs after reload',
  async ({ page, scheduledProject: { path } }) => {
    const other = await page.context().newPage()
    try {
      await page.goto(path)
      await other.goto(path)
      const firstSort = page.getByTestId('cloud-board-sort-by-pending')
      const secondSort = other.getByTestId('cloud-board-sort-by-completed')
      await expect(firstSort).toHaveAttribute('data-sort-rules', 'priority-desc')
      await expect(secondSort).toHaveAttribute('data-sort-rules', 'priority-desc')
      await firstSort.click()
      await page.getByTestId('cloud-board-sort-by-pending-manual').click()
      await firstSort.click()
      await secondSort.click()
      await other.getByTestId('cloud-board-sort-by-completed-rule-0-mode').click()
      await other.getByTestId('cloud-board-sort-by-completed-rule-0-mode-created-asc').click()
      await secondSort.click()
      await expect(page.getByTestId('cloud-board-sort-by-completed')).toHaveAttribute(
        'data-sort-rules',
        'created-asc'
      )
      await expect(other.getByTestId('cloud-board-sort-by-pending')).toHaveAttribute(
        'data-sort-rules',
        'manual'
      )
      await page.reload()
      await other.reload()
      for (const tab of [page, other]) {
        await expect(tab.getByTestId('cloud-board-sort-by-pending')).toHaveAttribute(
          'data-sort-rules',
          'manual'
        )
        await expect(tab.getByTestId('cloud-board-sort-by-completed')).toHaveAttribute(
          'data-sort-rules',
          'created-asc'
        )
      }
    } finally {
      await other.close()
    }
  }
)

projectTest(
  'restores each account lane rules after switching users in the same browser',
  async ({ page, scheduledProject: { path } }) => {
    await page.goto(path)
    const sort = page.getByTestId('cloud-board-sort-by-pending')
    await sort.click()
    await page.getByTestId('cloud-board-sort-by-pending-manual').click()
    await sort.click()
    try {
      await switchProjectAccount(page, path, REGULAR_USER.username, REGULAR_USER.password)
      await expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc')
      await sort.click()
      await page.getByTestId('cloud-board-sort-by-pending-rule-0-mode').click()
      await page.getByTestId('cloud-board-sort-by-pending-rule-0-mode-created-asc').click()
      await sort.click()
      await page.reload()
      await expect(sort).toHaveAttribute('data-sort-rules', 'created-asc')
    } finally {
      await switchProjectAccount(page, path, ADMIN_USER.username, ADMIN_USER.password)
    }
    await expect(sort).toHaveAttribute('data-sort-rules', 'manual')
  }
)

for (const view of ['calendar', 'gantt'] as const) {
  projectTest(
    `preserves ${view} through navigation, reload and Issue detail`,
    async ({ page, scheduledProject: { path, issueId, title } }) => {
      await page.goto(path)
      const card = page.getByTestId(`collaboration-issue-${issueId}`)
      await expect(card).toContainText(title)
      const snapshot = await webApi<{ items: Array<{ id: string; is_unread: boolean }> }>(
        page,
        `/api/v1/cloud-projects/${path.split('/').at(-1)}/board-snapshot`
      )
      expect(snapshot.items.find(item => item.id === issueId)?.is_unread).toBe(true)
      await expect(page.getByTestId(`cloud-todo-card-unread-${issueId}`)).toHaveCount(0)
      await expect(card).not.toHaveClass(/bg-focus\/10/)

      const handle = page.getByTestId(`cloud-todo-card-${issueId}`)
      await handle.scrollIntoViewIfNeeded()
      const box = await handle.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 20, box!.y + 20)
      await page.mouse.down()
      try {
        await page.mouse.move(box!.x + 30, box!.y + 20)
        await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
        await expect(page.getByTestId(`cloud-todo-card-unread-${issueId}`)).toHaveCount(0)
        // Release outside the original card so cancelling cannot produce a card click.
        await page.mouse.move(box!.x + 30, box!.y - 10)
        await page.keyboard.press('Escape')
      } finally {
        await page.mouse.up()
      }
      await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)
      await expect(page.getByTestId('collaboration-issue-detail')).toHaveCount(0)
      await expect(page).toHaveURL(path)

      await page.getByTestId(`collaboration-${view}-tab`).click()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()

      await page.getByTestId(`collaboration-${view}-issue-${issueId}`).first().click()
      await expect(page).toHaveURL(`${path}/issues/${issueId}?view=${view}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(`${path}/issues/${issueId}?view=${view}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      await page.getByTestId('cloud-todo-detail-close').click()
      await expect(page).toHaveURL(`${path}?view=${view}`)
      await expect(page.getByTestId(`collaboration-${view}`)).toBeVisible()
    }
  )
}

test('removes My Work and Run Center from navigation and their former URLs', async ({ page }) => {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  await expect(page.getByTestId('collaboration-nav-inbox')).toBeVisible()
  await expect(page.getByTestId('collaboration-nav-my-work')).toHaveCount(0)
  await expect(page.getByTestId('collaboration-nav-runs')).toHaveCount(0)
  for (const removed of ['my-work', 'runs']) {
    await page.goto(`/collaboration/${removed}`)
    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  }
})
