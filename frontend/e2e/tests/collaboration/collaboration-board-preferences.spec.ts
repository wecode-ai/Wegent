// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { LoginPage } from '../../pages/auth/login.page'
import { webApi } from '../../utils/collaboration-test-support'
import {
  boardTest,
  archive,
  createIssue,
  projectApi,
  projectPath,
  type Resource,
  type Project,
  type Issue,
} from '../../utils/collaboration-board-fixture'

type GroupBy = 'status' | 'priority' | 'assignee' | 'tag'

async function groupBy(page: Page, value: GroupBy): Promise<void> {
  await page.getByTestId('cloud-board-group-by').click()
  await page.getByTestId(`cloud-board-group-option-${value}`).click()
  await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute('data-value', value)
}

async function columnSort(page: Page, column: string, rules: string[] = []): Promise<void> {
  const testId = `cloud-board-sort-by-${column}`
  const trigger = page.getByTestId(testId)
  await trigger.click()
  await page.getByTestId(`${testId}-manual`).click()
  for (const [index, rule] of rules.entries()) {
    await page.getByTestId(`${testId}-add`).click()
    await page.getByTestId(`${testId}-rule-${index}-mode`).click()
    await page.getByTestId(`${testId}-rule-${index}-mode-${rule}`).click()
  }
  await trigger.click()
  await expect(trigger).toHaveAttribute('data-sort-rules', rules.join(',') || 'manual')
}

async function expectIssues(page: Page, all: Issue[], visible: Issue[]): Promise<void> {
  for (const issue of all) {
    await expect(page.getByTestId(`collaboration-issue-${issue.id}`)).toHaveCount(
      visible.includes(issue) ? 1 : 0
    )
  }
  await expect(page.getByText(/保存失败|Failed to save|Could not save/i)).toHaveCount(0)
}

async function switchUser(
  page: Page,
  currentUsername: string,
  nextUser: typeof REGULAR_USER
): Promise<void> {
  await page.getByRole('button').filter({ hasText: currentUsername }).click()
  await page.getByRole('menuitem', { name: /^(退出登录|Logout)$/ }).click()
  await page.waitForURL(url => url.pathname === '/login')
  const loginPage = new LoginPage(page)
  await loginPage.fillCredentials(nextUser.username, nextUser.password)
  await loginPage.clickLogin()
  await loginPage.waitForLoginComplete()
}

for (const role of ['Developer', 'Viewer'] as const) {
  boardTest.describe(role, () => {
    boardTest.use({ boardRole: role })
    boardTest.setTimeout(180_000)

    boardTest(
      'filters own Issues and isolates personal grouping preferences',
      async ({ board }) => {
        const {
          context,
          path,
          separatePath,
          all,
          mineAlpha,
          mineBeta,
          other,
          unassigned,
          owner,
          member,
          suffix,
        } = board
        let { page } = board
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'status'
        )
        await expectIssues(page, all, all)
        await groupBy(page, 'assignee')
        const filter = page.getByTestId('cloud-board-group-filter')
        const search = page.getByTestId('cloud-board-search')
        await filter.selectOption(`assignee-${member!.id}`)
        await expectIssues(page, all, [mineAlpha, mineBeta])
        await search.fill('alpha')
        await expectIssues(page, all, [mineAlpha])
        await search.fill(`no-match-${suffix}`)
        await expectIssues(page, all, [])
        await search.clear()
        await expectIssues(page, all, [mineAlpha, mineBeta])
        await filter.selectOption(`assignee-${owner.id}`)
        await expectIssues(page, all, [other])
        await filter.selectOption('assignee-unassigned')
        await expectIssues(page, all, [unassigned])
        await filter.selectOption('')
        await expectIssues(page, all, all)

        // Only grouping is a saved personal preference; search and value filters reset.
        await filter.selectOption(`assignee-${member!.id}`)
        await search.fill('alpha')
        await page.reload()
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'assignee'
        )
        await expect(page.getByTestId('cloud-board-group-filter')).toHaveValue('')
        await expect(page.getByTestId('cloud-board-search')).toHaveValue('')
        await expectIssues(page, all, all)
        await page.close()
        page = await context.newPage()
        await page.goto(path)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'assignee'
        )
        await expectIssues(page, all, all)

        await page.goto(separatePath)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'status'
        )
        await groupBy(page, 'tag')
        await page.goto(path)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'assignee'
        )
        await page.goto(separatePath)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute('data-value', 'tag')
        await page.goto(path)

        // Switch accounts in the same browser storage so an unscoped key cannot pass.
        await switchUser(page, REGULAR_USER.username, ADMIN_USER)
        await page.goto(path)
        expect((await webApi<{ id: number }>(page, '/api/users/me')).id).toBe(owner.id)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'status'
        )
        await groupBy(page, 'priority')
        await switchUser(page, ADMIN_USER.username, REGULAR_USER)
        await page.goto(path)
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute(
          'data-value',
          'assignee'
        )
        await expectIssues(page, all, all)
      }
    )

    boardTest('enforces drag permissions and persists permitted changes', async ({ board }) => {
      const { page, project, mineAlpha, owner, suffix } = board
      if (role === 'Viewer') {
        await expectViewerCannotDrag(page, project.id, mineAlpha, owner.id)
      } else {
        await expectDeveloperCanMove(page, project.id, owner.id, suffix)
      }
    })
  })
}

async function dragCard(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  expect(sourceBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + 20, sourceBox!.y + 20)
  await page.mouse.down()
  try {
    await page.mouse.move(sourceBox!.x + 30, sourceBox!.y + 20)
    await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    const targetBox = await target.boundingBox()
    expect(targetBox).not.toBeNull()
    await page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2,
      {
        steps: 15,
      }
    )
  } finally {
    await page.mouse.up()
  }
  await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)
}

async function expectViewerCannotDrag(
  page: Page,
  projectId: string,
  moving: Issue,
  otherUserId: number
): Promise<void> {
  const before = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
  const writes: string[] = []
  const recordWrite = (request: Request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/loop-items')) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  }
  page.on('request', recordWrite)
  try {
    for (const [group, sourceKey, targetKey] of [
      ['status', 'pending', 'completed'],
      ['priority', 'priority-none', 'priority-high'],
      ['assignee', `assignee-${moving.assignee_user_id}`, `assignee-${otherUserId}`],
      ['tag', 'tag-alpha', 'tag-beta'],
    ] as const) {
      await groupBy(page, group)
      const source = page
        .getByTestId(`cloud-todo-column-${sourceKey}`)
        .getByTestId(`cloud-todo-card-${moving.id}`)
      const target = page.getByTestId(`cloud-todo-column-dropzone-${targetKey}`)
      await source.scrollIntoViewIfNeeded()
      const sourceBox = await source.boundingBox()
      expect(sourceBox).not.toBeNull()
      await page.mouse.move(sourceBox!.x + 20, sourceBox!.y + 20)
      await page.mouse.down()
      try {
        await page.mouse.move(sourceBox!.x + 40, sourceBox!.y + 20, { steps: 5 })
        await expect(page.getByTestId('project-board-drag-overlay')).toHaveCount(0)
        await target.scrollIntoViewIfNeeded()
        const targetBox = await target.boundingBox()
        expect(targetBox).not.toBeNull()
        await page.mouse.move(targetBox!.x + 30, targetBox!.y + 10, { steps: 10 })
      } finally {
        await page.mouse.up()
      }
      await expect(page.getByTestId('collaboration-issue-detail')).toHaveCount(0)
      await page.reload()
      await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute('data-value', group)
      await expect(source).toHaveCount(1)
      const after = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
      for (const key of [
        'version',
        'priority',
        'status',
        'assignee_user_id',
        'sort_order',
        'tags',
      ] as const) {
        expect(after[key], `${group} drag changed ${key} for a Viewer in ${projectId}`).toEqual(
          before[key]
        )
      }
      expect(writes, `Viewer dragging in ${group} must not issue a write`).toEqual([])
    }
  } finally {
    page.off('request', recordWrite)
  }
}

async function expectSortedDropUnchanged(
  page: Page,
  moving: Issue,
  source: Locator,
  target: Locator
): Promise<void> {
  const before = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
  const writes: string[] = []
  const recordWrite = (request: Request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/loop-items')) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  }
  page.on('request', recordWrite)
  try {
    await dragCard(page, source, target)
    const after = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
    for (const key of [
      'version',
      'priority',
      'status',
      'assignee_user_id',
      'sort_order',
      'tags',
    ] as const) {
      expect(after[key], `A sorted same-column drop must preserve ${key}`).toEqual(before[key])
    }
    await page.reload()
    await expect(source).toHaveCount(1)
    const reloaded = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
    for (const key of [
      'version',
      'priority',
      'status',
      'assignee_user_id',
      'sort_order',
      'tags',
    ] as const) {
      expect(reloaded[key], `Reload must preserve ${key}`).toEqual(before[key])
    }
    expect(writes, 'A compound-sorted same-column drop must not write').toEqual([])
  } finally {
    page.off('request', recordWrite)
  }
}

async function expectManualDrop(
  page: Page,
  moving: Issue,
  source: Locator,
  target: Locator
): Promise<void> {
  const path = `/api/v1/loop-items/${moving.id}`
  const before = await webApi<Issue>(page, path)
  const saved = page.waitForResponse(
    response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === path
  )
  await dragCard(page, source, target)
  const response = await saved
  expect(response.ok(), `Manual reorder failed: ${await response.text()}`).toBe(true)
  expect(response.request().postDataJSON()).toHaveProperty('position')
  const after = await webApi<Issue>(page, path)
  expect(after.version).toBeGreaterThan(before.version)
  for (const key of ['priority', 'status', 'assignee_user_id', 'tags'] as const) {
    expect(after[key], `A manual same-column drop must preserve ${key}`).toEqual(before[key])
  }
}

async function expectDeveloperCanMove(
  page: Page,
  projectId: string,
  otherUserId: number,
  suffix: string
): Promise<void> {
  const title = `Developer reorder ${suffix}`
  // Creating as the Developer exercises their own implicit creator assignment.
  const first = await createIssue(page, projectId, `${title} first`)
  const second = await createIssue(page, projectId, `${title} second`)
  // Give both cards an explicit initial order; creation defaults may tie at zero.
  const initial = await webApi<{ items: Issue[] }>(
    page,
    `${projectApi(projectId)}/loop-items/reorder`,
    {
      method: 'POST',
      body: { parent_id: null, status: 'pending', item_ids: [first.id, second.id] },
    }
  )
  expect(initial.items.find(issue => issue.id === first.id)!.sort_order).toBeLessThan(
    initial.items.find(issue => issue.id === second.id)!.sort_order
  )
  await page.reload()
  await groupBy(page, 'status')
  await columnSort(page, 'pending')
  await page.getByTestId('cloud-board-search').fill(title)
  const card = (column: string, issueId = second.id) =>
    page.getByTestId(`cloud-todo-column-${column}`).getByTestId(`cloud-todo-card-${issueId}`)
  const orderedCards = page
    .getByTestId('cloud-todo-column-pending')
    .getByTestId(new RegExp(`^cloud-todo-card-(${first.id}|${second.id})$`))
  await expect(orderedCards).toHaveCount(2)
  await expect(orderedCards.first()).toHaveAttribute('data-testid', `cloud-todo-card-${first.id}`)
  const reordered = page.waitForResponse(
    response =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/v1/loop-items/${second.id}`
  )
  await dragCard(page, card('pending'), card('pending', first.id))
  expect((await reordered).ok()).toBe(true)
  const persistedFirst = await webApi<Issue>(page, `/api/v1/loop-items/${first.id}`)
  const persistedSecond = await webApi<Issue>(page, `/api/v1/loop-items/${second.id}`)
  expect(persistedSecond.sort_order).toBeLessThan(persistedFirst.sort_order)
  await page.reload()
  await page.getByTestId('cloud-board-search').fill(title)
  await expect(orderedCards).toHaveCount(2)
  await expect(orderedCards.first()).toHaveAttribute('data-testid', `cloud-todo-card-${second.id}`)
  const anchor = await createIssue(page, projectId, `${title} anchor`)
  await page.reload()

  for (const [group, sourceKey, targetKey, field, expected] of [
    ['status', 'pending', 'completed', 'status', 'completed'],
    ['priority', 'priority-none', 'priority-high', 'priority', 'high'],
    [
      'assignee',
      `assignee-${second.assignee_user_id}`,
      `assignee-${otherUserId}`,
      'assignee_user_id',
      otherUserId,
    ],
  ] as const) {
    const moving = group === 'status' ? second : first
    if (group !== 'status') {
      await webApi(page, `${projectApi(projectId)}/loop-items/reorder`, {
        method: 'POST',
        body: { parent_id: null, status: null, item_ids: [anchor.id, moving.id] },
      })
      await page.reload()
    }
    await groupBy(page, group)
    if (group !== 'status') {
      await columnSort(page, sourceKey, ['priority-desc', 'created-asc'])
      await expectSortedDropUnchanged(
        page,
        moving,
        card(sourceKey, moving.id),
        card(sourceKey, anchor.id)
      )
      await columnSort(page, sourceKey)
      await expectManualDrop(page, moving, card(sourceKey, moving.id), card(sourceKey, anchor.id))
      expect(
        (await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)).sort_order
      ).toBeLessThan((await webApi<Issue>(page, `/api/v1/loop-items/${anchor.id}`)).sort_order)
      await page.reload()
      const ordered = page
        .getByTestId(`cloud-todo-column-${sourceKey}`)
        .getByTestId(new RegExp(`^cloud-todo-card-(${moving.id}|${anchor.id})$`))
      await expect(ordered.first()).toHaveAttribute('data-testid', `cloud-todo-card-${moving.id}`)
    }
    const mutation = page.waitForResponse(response => {
      const pathname = new URL(response.url()).pathname
      return (
        ['PATCH', 'POST'].includes(response.request().method()) &&
        (pathname === `/api/v1/loop-items/${moving.id}` ||
          pathname === `${projectApi(projectId)}/loop-items/${moving.id}/assign`)
      )
    })
    await dragCard(
      page,
      card(sourceKey, moving.id),
      page.getByTestId(`cloud-todo-column-dropzone-${targetKey}`)
    )
    expect((await mutation).ok()).toBe(true)
    await expect
      .poll(async () => (await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`))[field])
      .toBe(expected)
    await page.reload()
    expect((await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`))[field]).toBe(expected)
    await expect(card(targetKey, moving.id)).toHaveCount(1)
    await expect(page.getByText(/保存失败|Failed to save|Could not save/i)).toHaveCount(0)
  }
}

test('keeps unrelated tags during real multi-column drops and persists manual same-column order', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  const suffix = crypto.randomUUID()
  const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
    method: 'POST',
    body: { name: `Tag board ${suffix}` },
  })
  let project: Project | undefined
  try {
    project = await webApi<Project>(page, '/api/v1/cloud-projects', {
      method: 'POST',
      body: {
        workspace_id: workspace.id,
        name: `Tag drops ${suffix}`,
        task_provider: 'local',
        visibility: 'private',
      },
    })
    await webApi(page, projectApi(project.id), {
      method: 'PATCH',
      body: { version: project.version, tags: ['alpha', 'beta', 'gamma', 'delta', 'keep'] },
    })
    const moving = await createIssue(page, project.id, `Multi-tag moving ${suffix}`, {
      tags: ['alpha', 'beta', 'keep'],
    })
    const sibling = await createIssue(page, project.id, `Same-column target ${suffix}`, {
      tags: ['alpha'],
    })
    const target = await createIssue(page, project.id, `Multi-tag target ${suffix}`, {
      tags: ['beta', 'gamma'],
    })
    await webApi(page, `${projectApi(project.id)}/loop-items/reorder`, {
      method: 'POST',
      body: { parent_id: null, status: null, item_ids: [sibling.id, moving.id, target.id] },
    })
    await page.goto(projectPath(workspace.id, project.id))
    await groupBy(page, 'tag')
    const column = (key: string) => page.getByTestId(`cloud-todo-column-${key}`)
    const card = (key: string, id = moving.id) => column(key).getByTestId(`cloud-todo-card-${id}`)
    const mutations: string[] = []
    const recordMutation = (request: Request) => {
      const pathname = new URL(request.url()).pathname
      if (
        ['PATCH', 'POST'].includes(request.method()) &&
        (pathname.includes('/loop-items/') || pathname.endsWith('/loop-items/reorder'))
      ) {
        mutations.push(pathname)
      }
    }
    page.on('request', recordMutation)
    try {
      await expect(card('tag-alpha')).toHaveCount(1)
      await expect(card('tag-beta')).toHaveCount(1)
      await expect(card('tag-keep')).toHaveCount(1)
      await columnSort(page, 'tag-alpha', ['priority-desc', 'created-asc'])
      await expectSortedDropUnchanged(
        page,
        moving,
        card('tag-alpha'),
        card('tag-alpha', sibling.id)
      )
      expect(mutations, 'A compound-sorted same-tag drop must not mutate the Issue').toEqual([])
      await columnSort(page, 'tag-alpha')
      await expectManualDrop(page, moving, card('tag-alpha'), card('tag-alpha', sibling.id))
      expect(mutations).toEqual([`/api/v1/loop-items/${moving.id}`])
      const reordered = await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)
      expect([...reordered.tags].sort()).toEqual(['alpha', 'beta', 'keep'])
      expect(reordered.sort_order).toBeLessThan(
        (await webApi<Issue>(page, `/api/v1/loop-items/${sibling.id}`)).sort_order
      )
      await page.reload()
      await expect(
        column('tag-alpha')
          .getByTestId(new RegExp(`^cloud-todo-card-(${moving.id}|${sibling.id})$`))
          .first()
      ).toHaveAttribute('data-testid', `cloud-todo-card-${moving.id}`)

      const dropAndVerify = async (
        sourceKey: string,
        destinationKey: string,
        tags: string[],
        targetId?: string
      ) => {
        const response = page.waitForResponse(
          response =>
            response.request().method() === 'PATCH' &&
            new URL(response.url()).pathname === `/api/v1/loop-items/${moving.id}`
        )
        await dragCard(
          page,
          card(sourceKey),
          targetId
            ? card(destinationKey, targetId)
            : page.getByTestId(`cloud-todo-column-dropzone-${destinationKey}`)
        )
        const saved = await response
        expect(saved.ok(), `Tag mutation failed: ${await saved.text()}`).toBe(true)
        expect(
          [...(await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)).tags].sort()
        ).toEqual([...tags].sort())
        await page.reload()
        await expect(page.getByTestId('cloud-board-group-by')).toHaveAttribute('data-value', 'tag')
        for (const tag of ['alpha', 'beta', 'gamma', 'delta', 'keep']) {
          await expect(card(`tag-${tag}`)).toHaveCount(tags.includes(tag) ? 1 : 0)
        }
        await expect(card('tag-untagged')).toHaveCount(tags.length === 0 ? 1 : 0)
        expect(
          [...(await webApi<Issue>(page, `/api/v1/loop-items/${moving.id}`)).tags].sort()
        ).toEqual([...tags].sort())
      }
      // The target appears in beta and gamma; its actual rendered column must win.
      await dropAndVerify('tag-alpha', 'tag-gamma', ['beta', 'gamma', 'keep'], target.id)
      // Moving to a tag already present must remove only the source and add no duplicates.
      await dropAndVerify('tag-gamma', 'tag-beta', ['beta', 'keep'], target.id)
      await dropAndVerify('tag-beta', 'tag-delta', ['delta', 'keep'])
      await dropAndVerify('tag-delta', 'tag-untagged', [])
      await dropAndVerify('tag-untagged', 'tag-alpha', ['alpha'])
    } finally {
      page.off('request', recordMutation)
    }
  } finally {
    if (project) await archive(page, projectApi(project.id))
    await archive(page, `/api/v1/workspaces/${workspace.id}`)
  }
})
