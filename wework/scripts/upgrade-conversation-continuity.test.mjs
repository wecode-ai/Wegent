import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUpgradeConversationContinuity } from '../e2e/desktop/modules/upgrade-conversation-continuity.mjs'

test('upgrade inference must retain both sides of every completed native turn', async () => {
  const continuity = createUpgradeConversationContinuity(
    () => ({ command: async () => undefined }),
    10_000
  )
  await continuity.send('source user', 'source assistant')
  assert.throws(() => continuity.observeModel({ input: ['source user'] }), /assistant output/)
  assert.throws(() => continuity.observeModel({ input: ['source assistant'] }), /user input/)
  continuity.observeModel({ input: ['source user', 'source assistant', 'upgraded user'] })
  await continuity.send('upgraded user', 'upgraded assistant')
  assert.throws(
    () => continuity.observeModel({ input: ['source user', 'source assistant'] }),
    /user input/
  )
  continuity.observeModel({
    input: ['source user', 'source assistant', 'upgraded user', 'upgraded assistant'],
  })
})

test('a failed send does not fabricate a completed history prerequisite', async () => {
  const continuity = createUpgradeConversationContinuity(
    () => ({
      command: async () => {
        throw new Error('not sent')
      },
    }),
    10_000
  )
  await assert.rejects(continuity.send('not sent user', 'not sent answer'), /not sent/)
  continuity.observeModel({ input: ['a different first request'] })
})

test('tool history requires an actual successful artifact and retains call identity at inference', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'wework-tool-continuity-'))
  try {
    const continuity = createUpgradeConversationContinuity(
      () => ({ command: async () => undefined }),
      10_000
    )
    continuity.seedTool(fixtureRoot)
    let toolResponse
    assert.equal(
      continuity.toolResponse(
        { tools: [{ type: 'custom', name: 'apply_patch' }] },
        {
          writeHead() {},
          end: value => {
            toolResponse = value
          },
        }
      ),
      true
    )
    assert.ok(toolResponse.includes('upgrade-persisted-tool-call'))
    await assert.rejects(continuity.send('source user', 'source assistant'), { code: 'ENOENT' })
    continuity.observeModel({ input: [] })
    await writeFile(
      join(fixtureRoot, 'upgrade-persisted-tool.txt'),
      'WEWORK_UPGRADE_REAL_TOOL_HISTORY\n'
    )
    await continuity.send('source user', 'source assistant')
    assert.throws(
      () => continuity.observeModel({ input: ['source user', 'source assistant'] }),
      /tool call\/output identity/
    )
    continuity.observeModel({
      input: [
        'source user',
        'source assistant',
        'upgrade-persisted-tool-call',
        'WEWORK_UPGRADE_REAL_TOOL_HISTORY',
      ],
    })
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
