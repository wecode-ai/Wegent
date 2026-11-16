import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupRenderingEvidence } from '../e2e/desktop/modules/setup-rendering-evidence.mjs'

test('saves positive rendering evidence after every setup stage without copying messages or logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-setup-rendering-'))
  try {
    const path = join(directory, 'setup.json')
    const capture = createSetupRenderingEvidence(
      {
        command: async () =>
          JSON.stringify({
            conversationRendering: { elements: { lists: { count: 1 } } },
            logs: ['private-message'],
          }),
      },
      path
    )
    await capture('input-ready')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).samples.length, 1)
    await capture('assistant-visible')
    const result = await readFile(path, 'utf8')
    assert.deepEqual(
      JSON.parse(result).samples.map(sample => sample.stage),
      ['input-ready', 'assistant-visible']
    )
    assert.equal(JSON.parse(result).samples[1].rendering.elements.lists.count, 1)
    assert.ok(!result.includes('private-message'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retains failed diagnostic attempts with explicit error status and no error contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-setup-rendering-'))
  try {
    const path = join(directory, 'setup.json')
    const capture = createSetupRenderingEvidence(
      {
        command: async () => {
          throw new Error('private-message')
        },
      },
      path
    )
    await capture('setup-failed')
    const result = await readFile(path, 'utf8')
    assert.deepEqual(JSON.parse(result).samples[0].error, { name: 'Error' })
    assert.ok(!result.includes('private-message'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
