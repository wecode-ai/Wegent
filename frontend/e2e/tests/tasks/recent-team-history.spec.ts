import { expect, type Page } from '@playwright/test'
import {
  checked,
  expectSelected,
  HISTORY_MODES,
  isHistoryRequest,
  test,
  type HistoryAccount,
  type HistoryTeam,
} from '../../fixtures/recent-team-history'

// Discovered by the default chromium project in the sharded e2e-tests.yml job.
// No business API, task state, WebSocket, or executor is mocked.
const MODEL_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'

async function openChat(page: Page, path = '/chat'): Promise<void> {
  const response = page.waitForResponse(response => isHistoryRequest(response.url()))
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  expect((await response).status()).toBe(200)
}

async function selectTeam(page: Page, team: HistoryTeam): Promise<void> {
  await page.getByTestId('agent-skill-selector-button').click()
  await page.getByTestId(`team-option-${team.name}`).click()
  await expectSelected(page, team)
}

async function holdHistory(page: Page) {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const requested = new Promise<void>(resolve => {
    entered = resolve
  })
  await page.route(
    url => isHistoryRequest(url.toString()),
    async route => {
      entered()
      await gate
      // Delay transport only; the real server still authenticates and reads the database.
      await route.continue()
    }
  )
  return {
    requested,
    release,
    async resume() {
      const response = page.waitForResponse(response => isHistoryRequest(response.url()))
      release()
      expect((await response).status()).toBe(200)
    },
  }
}

function observeSends(page: Page) {
  const sends: unknown[] = []
  const record = (frame: string) => {
    // Include the production /chat namespace and optional acknowledgement ID.
    if (!/^42(?:\/[^,]+,)?\d*\[/.test(frame)) return
    const event = JSON.parse(frame.slice(frame.indexOf('['))) as [string, unknown]
    if (event[0] === 'chat:send') sends.push(event[1])
  }
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => record(payload.toString()))
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.searchParams.get('transport') === 'polling') {
      for (const packet of (request.postData() || '').split('\x1e')) record(packet)
    }
  })
  return sends
}

async function expectPersistedSend(
  page: Page,
  history: HistoryAccount,
  team: HistoryTeam,
  prompt: string
): Promise<number> {
  await expect(page).toHaveURL(/[?&]taskId=\d+/)
  const id = Number(new URL(page.url()).searchParams.get('taskId'))
  await expect
    .poll(
      async () =>
        checked(await history.api.get<{ task_status: string }>(`/api/tasks/${id}/runtime-check`))
          .task_status,
      { timeout: 30_000 }
    )
    .toBe('COMPLETED')
  const detail = checked(
    await history.api.get<{
      team: HistoryTeam
      subtasks: Array<{ role: string; prompt: string }>
    }>(`/api/tasks/${id}`)
  )
  expect(detail.team.id).toBe(team.id)
  expect(
    detail.subtasks.filter(item => item.role === 'USER' && item.prompt === prompt)
  ).toHaveLength(1)
  expect((await history.tasks()).filter(item => item.prompt === prompt)).toHaveLength(1)
  return id
}

test('real sends restore the last same-mode team after refresh and in a new tab', async ({
  page,
  context,
  history,
  request,
}) => {
  const recent = await history.team('recent')
  const defaultTeam = await history.defaultTeam()
  expect(recent.id).not.toBe(defaultTeam.id)
  const prompt = `${history.prefix}-manual-send`
  const configured = await request.post(`${MODEL_URL}/tool-scenarios`, {
    data: { matchText: prompt, steps: [{ responseContent: 'Recent team saved.' }] },
  })
  expect(configured.status()).toBe(200)
  try {
    await openChat(page)
    await expectSelected(page, defaultTeam)
    await selectTeam(page, recent)
    await page.getByTestId('message-input').fill(prompt)
    await page.getByTestId('send-button').click()
    await expectPersistedSend(page, history, recent, prompt)
    expect((await history.recent()).map(team => team.id)).toEqual([recent.id])
    await openChat(page)
    await expectSelected(page, recent)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expectSelected(page, recent)
    const tab = await context.newPage()
    try {
      await openChat(tab)
      await expectSelected(tab, recent)
    } finally {
      await tab.close()
    }
  } finally {
    const removed = await request.delete(
      `${MODEL_URL}/tool-scenarios?matchText=${encodeURIComponent(prompt)}`
    )
    expect(removed.status()).toBe(200)
  }
})

test('all six modes isolate persisted history, including browser chat/code transitions', async ({
  page,
  history,
}) => {
  test.setTimeout(120_000)
  const teams = new Map<string, HistoryTeam>()
  for (const mode of HISTORY_MODES) {
    const team = await history.team(mode)
    teams.set(mode, team)
    await history.seed(team, mode)
  }
  for (const mode of HISTORY_MODES) {
    expect((await history.recent(mode)).map(team => team.id)).toEqual([teams.get(mode)!.id])
  }
  await openChat(page)
  await expectSelected(page, teams.get('chat')!)
  await openChat(page, '/chat?agent=code')
  await expectSelected(page, teams.get('code')!)
  await openChat(page)
  await expectSelected(page, teams.get('chat')!)
})

test('switching accounts in the same browser never reuses another account history', async ({
  page,
  context,
  baseURL,
  history,
  createHistoryAccount,
}) => {
  const first = await history.team('first-user')
  await history.seed(first)
  const other = await createHistoryAccount()
  const second = await other.team('second-user')
  await other.seed(second)
  await openChat(page)
  await expectSelected(page, first)
  await other.authenticate(context, baseURL!)
  await openChat(page)
  await expectSelected(page, second)
  expect((await other.recent()).map(team => team.id)).toEqual([second.id])
  await history.authenticate(context, baseURL!)
  await openChat(page)
  await expectSelected(page, first)
})

test('no history and a removed historical team both use the configured default', async ({
  page,
  history,
}) => {
  const defaultTeam = await history.defaultTeam()
  expect(await history.recent()).toEqual([])
  await openChat(page)
  await expectSelected(page, defaultTeam)
  const removed = await history.team('removed')
  await history.seed(removed)
  await history.removeTeam(removed)
  expect(await history.recent()).toEqual([])
  await openChat(page)
  await expectSelected(page, defaultTeam)
})

test('failed history transport settles on the configured default', async ({ page, history }) => {
  const recent = await history.team('recent')
  await history.seed(recent)
  const defaultTeam = await history.defaultTeam()
  const failed = page.waitForEvent('requestfailed', request => isHistoryRequest(request.url()))
  await page.route(
    url => isHistoryRequest(url.toString()),
    route => route.abort('connectionfailed')
  )
  await page.goto('/chat', { waitUntil: 'domcontentloaded' })
  await failed
  await expectSelected(page, defaultTeam)
  // A subsequent manual choice must still work after the failure has settled.
  await selectTeam(page, recent)
})

test('manual choice survives late history and can restore the configured default', async ({
  page,
  history,
}) => {
  const recent = await history.team('recent')
  const manual = await history.team('manual')
  await history.seed(recent)
  const defaultTeam = await history.defaultTeam()
  const gate = await holdHistory(page)
  try {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' })
    await gate.requested
    await selectTeam(page, manual)
    await gate.resume()
    await page.waitForTimeout(600)
    await expectSelected(page, manual)
    await page.getByTestId('clear-team-button').click()
    await expectSelected(page, defaultTeam)
    // Returning to a new chat still uses task history, not the unsent manual choice.
    await openChat(page)
    await expectSelected(page, recent)
  } finally {
    gate.release()
  }
})

for (const target of ['teamId', 'teamName'] as const) {
  test(`autoSend honors explicit ${target} over history and persists that team once`, async ({
    page,
    history,
    request,
  }) => {
    const recent = await history.team('recent')
    const explicit = await history.team('explicit')
    await history.seed(recent)
    const prompt = `${history.prefix}-${target}-send`
    const sends = observeSends(page)
    const configured = await request.post(`${MODEL_URL}/tool-scenarios`, {
      data: { matchText: prompt, steps: [{ responseContent: 'Explicit team selected.' }] },
    })
    expect(configured.status()).toBe(200)
    try {
      const params = new URLSearchParams({ q: prompt, autoSend: 'true', teamNamespace: 'default' })
      params.set(target, target === 'teamId' ? String(explicit.id) : explicit.name)
      await page.goto(`/chat?${params}`, { waitUntil: 'domcontentloaded' })
      await expectPersistedSend(page, history, explicit, prompt)
      expect(sends).toHaveLength(1)
    } finally {
      const removed = await request.delete(
        `${MODEL_URL}/tool-scenarios?matchText=${encodeURIComponent(prompt)}`
      )
      expect(removed.status()).toBe(200)
    }
  })
}

test('an existing task wins over recent history, URL team, and autoSend', async ({
  page,
  history,
}) => {
  const existing = await history.team('existing')
  const recent = await history.team('recent')
  const task = await history.seed(existing)
  await history.seed(recent)
  expect((await history.recent())[0].id).toBe(recent.id)
  const before = await history.tasks()
  const sends = observeSends(page)
  await page.goto(`/chat?taskId=${task.id}&teamId=${recent.id}&q=must-not-send&autoSend=true`, {
    waitUntil: 'domcontentloaded',
  })
  await expectSelected(page, existing)
  await expect(page.getByTestId('messages-container')).toContainText(task.prompt)
  expect(sends).toHaveLength(0)
  expect((await history.tasks()).map(item => item.id).sort()).toEqual(
    before.map(item => item.id).sort()
  )
})

test('autoSend waits for late history, then sends once using the persisted recent team', async ({
  page,
  history,
  request,
}) => {
  const recent = await history.team('recent')
  await history.seed(recent)
  const defaultTeam = await history.defaultTeam()
  const prompt = `${history.prefix}-delayed-send`
  const sends = observeSends(page)
  const gate = await holdHistory(page)
  const configured = await request.post(`${MODEL_URL}/tool-scenarios`, {
    data: { matchText: prompt, steps: [{ responseContent: 'History resolved before send.' }] },
  })
  expect(configured.status()).toBe(200)
  try {
    await page.goto(`/chat?q=${prompt}&autoSend=true`, { waitUntil: 'domcontentloaded' })
    await gate.requested
    await expectSelected(page, defaultTeam)
    await expect(page.getByTestId('message-input')).toHaveText(prompt)
    // Observe several real readiness polling intervals before releasing the history request.
    await page.waitForTimeout(600)
    expect(sends).toHaveLength(0)
    expect(await history.tasks()).toHaveLength(1)
    await gate.resume()
    await expectPersistedSend(page, history, recent, prompt)
    expect(sends).toHaveLength(1)
    await expect(page).not.toHaveURL(/autoSend=/)
  } finally {
    gate.release()
    const removed = await request.delete(
      `${MODEL_URL}/tool-scenarios?matchText=${encodeURIComponent(prompt)}`
    )
    expect(removed.status()).toBe(200)
  }
})

for (const reason of ['timeout', 'typing'] as const) {
  test(`autoSend cancels after ${reason} even when history subsequently arrives`, async ({
    page,
    history,
  }) => {
    const recent = await history.team('recent')
    await history.seed(recent)
    const sends = observeSends(page)
    const gate = await holdHistory(page)
    const prompt = `${history.prefix}-cancelled-send`
    try {
      await page.goto(`/chat?q=${prompt}&autoSend=true`, { waitUntil: 'domcontentloaded' })
      await gate.requested
      const input = page.getByTestId('message-input')
      await expect(input).toHaveText(prompt)
      if (reason === 'typing') {
        await input.press('End')
        await input.pressSequentially(' edited')
      }
      // Real timeout; no fake clocks or application state. URL cleanup marks cancellation.
      await expect(page).not.toHaveURL(/autoSend=/, { timeout: 15_000 })
      await gate.resume()
      await expectSelected(page, recent)
      await page.waitForTimeout(600)
      expect(sends).toHaveLength(0)
      expect(await history.tasks()).toHaveLength(1)
      await expect(input).toContainText(prompt)
    } finally {
      gate.release()
    }
  })
}
