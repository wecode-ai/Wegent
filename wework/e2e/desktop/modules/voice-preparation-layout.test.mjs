import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../checkpoint-catalog.mjs'
import { assertVoicePreparationLayout } from './voice-preparation-layout.mjs'

const visible = {
  top: 100,
  bottom: 144,
  left: 200,
  right: 300,
  width: 100,
  height: 44,
  viewportWidth: 760,
  viewportHeight: 760,
}

test('voice layout retains the existing CI checkpoint and original scenario dependency', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES['voice-input'],
    './scenarios/voice-input-layout.scenario.mjs'
  )
  assert.ok(catalog.ci.core_segments.includes('voice-input'))
  for (const path of [
    'wework/e2e/desktop/scenarios/voice-input.scenario.mjs',
    'wework/e2e/desktop/modules/voice-preparation-layout.mjs',
  ])
    assert.deepEqual(catalog.PATH_TARGETS.get(path), ['core:voice-input'])
})

test('layout acceptance rejects the observed offscreen preparation dialog before any scrolling', async () => {
  const commands = []
  await assert.rejects(
    assertVoicePreparationLayout({
      async command(action, selector) {
        commands.push(action)
        assert.equal(selector, '.wework-voice-setup-modal')
        return JSON.stringify([
          { ...visible, top: -204.953125, bottom: 964.9609375, height: 1169.9140625 },
        ])
      },
    }),
    /Voice preparation dialog must remain inside the viewport/
  )
  assert.deepEqual(commands, ['getElementMetrics'])
})

test('layout acceptance rejects clipped body even when programmatic scrolling could succeed', async () => {
  const commands = []
  await assert.rejects(
    assertVoicePreparationLayout({
      async command(action, selector) {
        commands.push(action)
        if (action === 'getStyle') return 'hidden'
        return JSON.stringify([
          {
            ...visible,
            clientHeight: 44,
            scrollHeight: selector.endsWith(':last-child') ? 1000 : 44,
          },
        ])
      },
    }),
    /must allow user scrolling/
  )
  assert.ok(!commands.includes('scrollToBottomAsUser'))
})
