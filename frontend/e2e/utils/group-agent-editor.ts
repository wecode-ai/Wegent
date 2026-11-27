// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import type { Bot, Team } from '../../src/types/api'
import type { ApiClient } from './api-client'
import { buildStorageState, getJwtExpiryMs } from './auth-state'

const APP_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'

type TeamDetail = Omit<Team, 'bots'> & {
  bots: Array<{ bot_id: number; role?: string; bot: Bot & { user_id: number } }>
}

export async function readTeamDetail(api: ApiClient, teamId: number): Promise<TeamDetail> {
  const response = await api.get<TeamDetail>(`/api/teams/${teamId}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data!
}

export async function assertLeaderReloadOnReopen(
  page: Page,
  creator: ApiClient,
  teamId: number,
  botId: number
): Promise<void> {
  const dialog = page.getByTestId('team-edit-dialog')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const prompt = 'The creator changed this private Bot while the group editor was closed.'
  const saved = await creator.put(`/api/bots/${botId}`, { system_prompt: prompt })
  expect(saved.status, JSON.stringify(saved.data)).toBe(200)

  await page.getByTestId(`edit-team-button-${teamId}`).click()
  await expect(dialog.getByTestId('simple-prompt-textarea')).toHaveValue(prompt)
}

export async function assertCatalogSelectionIds(
  page: Page,
  teamId: number,
  botId: number,
  shadowed: { name: string; id: number },
  shared: { name: string; id: number },
  readSelection: () => Promise<{
    agent_config: { bind_model: string; bind_model_type: string }
  }>
): Promise<void> {
  await page.reload()
  const catalogResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith('/models/unified')
  )
  await page.getByTestId('edit-team-button-' + teamId).click()
  const response = await catalogResponse
  expect(response.status()).toBe(200)
  const catalog = (await response.json()).data
  for (const model of [shadowed, shared]) {
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: model.id, name: model.name, type: 'public' }),
      ])
    )
  }

  const dialog = page.getByTestId('team-edit-dialog')
  const original = await readSelection()
  await saveCatalogSelection(page, dialog, botId, shadowed, 403)
  await expect(dialog).toBeVisible()
  expect(await readSelection()).toEqual(original)
  await saveCatalogSelection(page, dialog, botId, shared, 200)
  await expect(dialog).toBeHidden({ timeout: 30000 })
  expect((await readSelection()).agent_config).toMatchObject({
    bind_model: shared.name,
    bind_model_type: 'public',
  })
  await page.getByTestId('edit-team-button-' + teamId).click()
  await expect(dialog.getByTestId('simple-model-select')).toHaveText(shared.name)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

async function saveCatalogSelection(
  page: Page,
  dialog: Locator,
  botId: number,
  model: { name: string; id: number },
  status: number
): Promise<void> {
  await dialog.getByTestId('simple-model-select').click()
  await page.getByTestId('model-cascade-search-input').fill(model.name)
  await page.getByTestId('model-option-' + model.name).click()
  const saved = page.waitForResponse(
    response =>
      new URL(response.url()).pathname.endsWith('/bots/' + botId) &&
      response.request().method() === 'PUT'
  )
  await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
  const response = await saved
  expect(response.request().postDataJSON()).toMatchObject({ model_id: model.id })
  expect(response.status(), await response.text()).toBe(status)
}

export async function openUserPage(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_BASE_URL,
    storageState: buildStorageState(APP_BASE_URL, token, getJwtExpiryMs(token)),
    viewport: { width: 1280, height: 720 },
  })
  // Permission tests start after onboarding, which otherwise takes keyboard focus.
  await context.addInitScript(() => {
    localStorage.setItem('user_onboarding_completed', 'true')
  })
  return context.newPage()
}

async function recordQuickCreateActivation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: unknown[] = []
    const elementIds = new WeakMap<Element, number>()
    let nextElementId = 0
    Reflect.set(window, '__wegentQuickCreateActivation', events)
    const describe = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      if (!elementIds.has(target)) elementIds.set(target, ++nextElementId)
      return {
        elementId: elementIds.get(target),
        tag: target.tagName,
        testId: target.closest('[data-testid]')?.getAttribute('data-testid'),
        connected: target.isConnected,
      }
    }
    for (const type of ['focusin', 'focusout', 'keydown', 'keyup', 'click']) {
      for (const capture of [true, false]) {
        document.addEventListener(
          type,
          event => {
            const key = event instanceof KeyboardEvent ? event.key : undefined
            if (key && !['Enter', ' ', 'Tab', 'Escape'].includes(key)) return
            events.push({
              time: performance.now(),
              type,
              capture,
              key,
              prevented: event.defaultPrevented,
              documentFocused: document.hasFocus(),
              target: describe(event.target),
              active: describe(document.activeElement),
              trigger: describe(document.querySelector('[data-testid="quick-create-agent"]')),
              stack: type === 'focusin' ? new Error().stack : undefined,
            })
            if (events.length > 100) events.shift()
          },
          capture
        )
      }
    }
  })
}

// The quick create dialog is the chat entry that renders the agent editor
// without preloading any writable group list.
export async function openQuickCreateDialog(page: Page): Promise<Locator> {
  await recordQuickCreateActivation(page)
  await page.goto('/chat', { waitUntil: 'domcontentloaded' })
  const trigger = page.getByTestId('quick-create-agent').first()
  await expect(trigger).toBeVisible({ timeout: 30000 })
  // The card animates continuously, so pointer clicks never settle; the native
  // button is keyboard activatable.
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByTestId('team-edit-dialog')
  try {
    await expect(dialog).toBeVisible({ timeout: 15000 })
  } finally {
    const events = await page.evaluate(() => Reflect.get(window, '__wegentQuickCreateActivation'))
    await test.info().attach('quick-create-activation', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    })
  }
  return dialog
}

// Agents created from the chat entry are personal resources; the selected team
// target only adds a group binding.
export async function findCreatedTeam(api: ApiClient, displayName: string) {
  const response = await api.get<{
    items: Array<{ id: number; name: string; displayName?: string; namespace: string }>
  }>(`/api/teams?${new URLSearchParams({ scope: 'personal' })}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return (response.data?.items ?? []).find(
    team => team.displayName === displayName || team.name === displayName
  )
}

export async function readGroupBindings(api: ApiClient, teamId: number): Promise<string[]> {
  const response = await api.get<{ group_names: string[] }>(
    `/api/resource-library/agents/${teamId}/bindings`
  )
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data?.group_names ?? []
}
