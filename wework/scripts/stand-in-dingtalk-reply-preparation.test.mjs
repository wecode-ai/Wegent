import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { verifyDingTalkDelivery } from '../e2e/desktop/modules/stand-in-dingtalk-delivery.mjs'
import { DINGTALK_DELEGATION_IDS } from '../e2e/desktop/modules/stand-in-dingtalk-delegation-fixture.mjs'
import { createDingTalkReplyStory } from '../e2e/desktop/modules/stand-in-dingtalk-reply-story.mjs'

afterEach(() => vi.unstubAllEnvs())

test('reply story reuses the prepared binary without a compiler in the standard user PATH', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'dingtalk-reply-'))
  try {
    const prepared = join(resultDir, 'prepared-story.exe')
    await writeFile(prepared, 'precompiled protocol fixture')
    vi.stubEnv('WEWORK_E2E_DWS_REPLY_FIXTURE_BIN', prepared)
    vi.stubEnv('PATH', '')
    const context = { appEnvironment: {} }
    const baseline = {
      prepareApp: vi.fn(async value => {
        value.appEnvironment.DWS_BINARY_PATH = '/prepared/baseline'
      }),
    }
    await createDingTalkReplyStory({ resultDir }).prepareApp(context, baseline)
    expect(baseline.prepareApp).toHaveBeenCalledExactlyOnceWith(context)
    expect(context.appEnvironment.DWS_BINARY_PATH).toBe(
      join(resultDir, process.platform === 'win32' ? 'source-story-dws.exe' : 'source-story-dws')
    )
    expect(await readFile(context.appEnvironment.DWS_BINARY_PATH, 'utf8')).toBe(
      'precompiled protocol fixture'
    )
    expect(await readFile(join(resultDir, 'dingtalk-story/baseline-path.txt'), 'utf8')).toBe(
      '/prepared/baseline'
    )
    expect(
      JSON.parse(await readFile(join(resultDir, 'dingtalk-story/mentions.json'), 'utf8'))
    ).toMatchObject({ success: true, result: { conversationMessagesList: [] } })
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

/** Replay the channel-query/UI-publication ordering with the real delivery verifier. */
function deliveryReplay(mode = 'delayed', overrides = {}) {
  const profile = DINGTALK_DELEGATION_IDS.profile
  const pendingId = 'pending-task-receipt'
  const record = (id, status) => ({
    id,
    recordId: id,
    text: id,
    delegationResult: {
      status,
      channelTaskId: `task-${id}`,
      receiptId: null,
      attemptId: `${id}-attempt`,
      reason: 'The source changed',
    },
  })
  const pending = record(pendingId, 'unknown')
  const rejected = record('rejected-submit', 'failed')
  const changed = record('changed-evidence', 'failed')
  const rows = Array.from({ length: 3 }, () => ({
    operation: 'query-send-status',
    taskId: `task-${pendingId}`,
    profile,
    matching: false,
  }))
  let selected
  let takenOver = false
  let released = false
  let clicks = 0
  let published = false
  const receiptWaits = []
  const commands = []
  const mailbox = overrides.mailbox ?? {
    async reads() {
      return rows
    },
    async replies() {
      return [pending, rejected].map(row => ({
        messageId: row.id,
        uuid: row.delegationResult.attemptId,
      }))
    },
    async releaseMatchingReceipt() {
      released = true
    },
  }
  const wait = async (ready, label) => {
    const deadline = Date.now() + (overrides.uiTimeout ?? 10_000)
    while (Date.now() < deadline) {
      if (ready()) return ''
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(label)
  }
  const control = {
    async command(action, selector = '', options = {}) {
      commands.push({ action, selector, ...options })
      if (action === 'setAppPreferences') return ''
      if (action === 'snapshot')
        return JSON.stringify({ testIds: ['general-experimental-features-toggle'] })
      if (action === 'getAttribute') return selector === 'html' ? 'en' : 'true'
      if (action === 'getElementCount')
        return selector.includes('message-center-filter') ? '1' : '0'
      if (action === 'getText')
        return published ? `Channel receipt accepted-${pendingId}` : 'Delivery unknown'
      if (action === 'clickWhenEnabled') {
        for (const row of [pending, rejected, changed])
          if (selector.includes(`message-center-record-${row.recordId}`)) selected = row
        if (selector.includes('message-center-take-over')) takenOver = true
        if (selector.includes('message-center-verify-delivery')) {
          clicks++
          if (overrides.query) {
            void overrides.query(clicks).then(matching => {
              if (matching)
                setTimeout(() => {
                  published = true
                }, overrides.renderDelay ?? 0)
            })
          } else if (clicks === 1) rows.push({ ...rows[0] })
          else {
            if (!released) throw new Error('Matching receipt was not released')
            if (mode !== 'no-response')
              setTimeout(() => {
                const query = {
                  ...rows[0],
                  matching: mode !== 'mismatch',
                  profile: mode === 'wrong-profile' ? 'other-account' : profile,
                  taskId: mode === 'wrong-task' ? 'task-other-message' : rows[0].taskId,
                }
                rows.push(query)
                if (mode === 'extra-query') rows.push(query)
                if (mode === 'delayed')
                  setTimeout(() => {
                    published = true
                  }, 3000)
                else published = true
              }, 8000)
          }
        }
        return ''
      }
      if (action === 'waitFor') {
        if (options.text === `accepted-${pendingId}`) {
          receiptWaits.push(Date.now())
          return wait(() => published, 'Timed out waiting for accepted-pending-task-receipt')
        }
        if (options.text === 'Delivery unknown' && published)
          throw new Error('Premature delivery confirmation')
        if (
          options.visible === false &&
          selector.includes('message-center-take-over') &&
          !takenOver
        )
          throw new Error('Takeover action remains visible')
        if (
          options.visible === false &&
          selector.includes('message-center-verify-delivery') &&
          selected === pending &&
          !published
        )
          throw new Error('Verification action remains visible')
        if (options.text === 'Delivery confirmed')
          return wait(() => published, 'Delivery was not confirmed')
        if (options.text === 'Taken over by you' && !takenOver)
          throw new Error('Owner takeover lost')
        if (options.text === 'Delivery failed' && selected?.delegationResult.status !== 'failed')
          throw new Error('Wrong failed record')
        return ''
      }
      if (action === 'scrollIntoView' || action === 'click') return ''
      throw new Error(`Unexpected delivery replay action: ${action}`)
    },
  }
  return {
    control,
    parameters: {
      mailbox,
      automaticallyConfirmed: [],
      pending,
      rejected,
      changed,
      timeout: 10_000,
    },
    receiptWaits,
    rows,
    commands,
    clickCount: () => clicks,
  }
}

test('delivery verifier waits for the delayed matching query before starting the receipt UI deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  try {
    const replay = deliveryReplay()
    const finished = verifyDingTalkDelivery(replay.control, replay.parameters).then(
      result => ({ result, at: Date.now() }),
      error => ({ error })
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const outcome = await finished
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toMatchObject({ confirmed: 'pending-task-receipt', ownerTakeover: true })
    expect(replay.receiptWaits).toEqual([8000])
    expect(outcome.at).toBe(11_000)
    expect(replay.clickCount()).toBe(2)
    expect(replay.rows).toHaveLength(5)
  } finally {
    vi.useRealTimers()
  }
})

test.each(['no-response', 'mismatch', 'wrong-profile', 'wrong-task', 'extra-query'])(
  'delivery verifier keeps the matching-query deadline and rejects %s before receipt assertions',
  async mode => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const replay = deliveryReplay(mode)
      const finished = verifyDingTalkDelivery(replay.control, replay.parameters).then(
        result => ({ result }),
        error => ({ error })
      )
      await vi.advanceTimersByTimeAsync(12_000)
      const outcome = await finished
      expect(outcome.result).toBeUndefined()
      expect(outcome.error?.message).toContain(
        'The second UI verification must query the matching recorded channel task'
      )
      expect(replay.receiptWaits).toEqual([])
      expect(replay.clickCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  }
)
