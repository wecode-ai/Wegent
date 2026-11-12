import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDesktopCheckpointCatalog,
  readDesktopCheckpointDefinitions,
} from '../e2e/desktop/checkpoint-catalog.mjs'

test('native computer use files select the focused checkpoint and serialize native focus', () => {
  const catalog = buildDesktopCheckpointCatalog(readDesktopCheckpointDefinitions())
  for (const pattern of [
    'wework/electron/src/host/computer-use-driver-*',
    'wework/e2e/desktop/modules/computer-use-*',
    'wework/scripts/computer-use-checkpoint.test.mjs',
  ]) {
    assert.deepEqual(catalog.PATH_TARGETS.get(pattern), ['core:computer-use'])
  }
  assert.deepEqual(catalog.CHECKPOINT_RESOURCES.get('computer-use'), ['macos-inspector-foreground'])
})
