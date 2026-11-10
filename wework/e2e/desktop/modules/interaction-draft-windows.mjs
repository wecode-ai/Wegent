import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_STEP_TIMEOUT_MS, WORKBENCH_READY_TIMEOUT_MS, withTimeout } from './shared.mjs'
import { pendingFixture } from './native-reply-recovery.mjs'

const PENDING_TAB = '[data-testid="workspace-tab-select-pending-interactions"]'
const PENDING_PAGE = '[data-testid="runtime-interactions-page"]'
const SECONDARY_DRAFT_ID = 'e2e:interaction-draft-window:secondary'
const SECONDARY_DRAFT_TEXT = 'SECOND_WINDOW_DRAFT'

function draftText(value) {
  return typeof value === 'string' ? value : value?.text
}

/** Poll a synchronous file snapshot until it proves the expected persisted state. */
async function waitFor(read, ready, message) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (ready(last)) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`)
}

/** Open a second real renderer before the main-window draft is written. */
export async function openInteractionDraftWindow({ control, electronUserDataDirectory, question }) {
  const storagePath = join(electronUserDataDirectory, 'renderer-local-storage.json')
  await control.command('flushRendererStorage', 'body')
  const fixture = await pendingFixture(storagePath, question)
  await control.command('waitFor', PENDING_TAB, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  const activeTab = await control.command(
    'getAttribute',
    '[data-testid^="workspace-tab-select-"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  await control.command('contextMenu', PENDING_TAB)
  const readyCount = control.readyCount
  await control.command('click', '[data-testid="workspace-tab-open-new-window"]')
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The second interaction-draft window did not connect'
  )
  const detached = { command: (...args) => control.commandForWindow(ready.windowLabel, ...args) }
  const main = { command: (...args) => control.commandForWindow('main', ...args) }
  await detached.command('waitFor', PENDING_PAGE, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  // Initialize this window's production store while its draft snapshot is still empty.
  await detached.command('interactionDraftSnapshot', 'body', {
    value: JSON.stringify({ accountKey: fixture.accountKey }),
  })
  // Keep a main-window store alive so the later secondary write proves cross-window synchronization.
  await main.command('interactionDraftSnapshot', 'body', {
    value: JSON.stringify({ accountKey: fixture.accountKey }),
  })
  control.activateWindow('main')
  await main.command('click', `[data-testid=${JSON.stringify(activeTab)}]`)
  await main.command('waitFor', `[data-testid=${JSON.stringify(activeTab)}][aria-selected="true"]`)
  await main.command('focusMainWindow', 'body')

  const readDrafts = async () => {
    const { entries } = JSON.parse(await readFile(storagePath, 'utf8'))
    const raw = entries[`wework.interactions:${fixture.accountKey}:drafts`]
    return raw ? JSON.parse(raw) : {}
  }

  return {
    fixture,
    // The main draft comes from the real UI. The second window writes a distinct synthetic draft
    // because this fixture exposes only one single-question request; both share the production map.
    async verifyMerge(mainDraft) {
      await main.command('flushRendererStorage', 'body')
      await waitFor(
        async () => draftText((await readDrafts())[fixture.interactionId]),
        text => text === mainDraft,
        'The main window draft was not persisted before the second-window write'
      )

      await detached.command('interactionDraftSet', 'body', {
        value: JSON.stringify({
          accountKey: fixture.accountKey,
          id: SECONDARY_DRAFT_ID,
          text: SECONDARY_DRAFT_TEXT,
        }),
      })

      const merged = await readDrafts()
      assert.equal(
        draftText(merged[fixture.interactionId]),
        mainDraft,
        'A stale second window overwrote the main-window draft'
      )
      assert.equal(draftText(merged[SECONDARY_DRAFT_ID]), SECONDARY_DRAFT_TEXT)
      await waitFor(
        async () =>
          JSON.parse(
            await main.command('interactionDraftSnapshot', 'body', {
              value: JSON.stringify({ accountKey: fixture.accountKey }),
            })
          ),
        snapshot =>
          draftText(snapshot[fixture.interactionId]) === mainDraft &&
          draftText(snapshot[SECONDARY_DRAFT_ID]) === SECONDARY_DRAFT_TEXT,
        'The main window did not observe the merged draft state'
      )

      await detached.command('interactionDraftSet', 'body', {
        value: JSON.stringify({
          accountKey: fixture.accountKey,
          id: SECONDARY_DRAFT_ID,
          text: '',
        }),
      })
      assert.equal(
        draftText((await readDrafts())[SECONDARY_DRAFT_ID]),
        undefined,
        'The temporary second-window draft was not cleared'
      )
    },
    async close() {
      try {
        await detached.command('contextMenu', PENDING_TAB)
        await detached.command('click', '[data-testid="workspace-tab-return-to-main"]')
      } finally {
        control.activateWindow('main')
        await control.command('waitFor', PENDING_TAB, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
        await main.command('click', `[data-testid=${JSON.stringify(activeTab)}]`)
        await main.command(
          'waitFor',
          `[data-testid=${JSON.stringify(activeTab)}][aria-selected="true"]`
        )
        await main.command('focusMainWindow', 'body')
      }
    },
  }
}
