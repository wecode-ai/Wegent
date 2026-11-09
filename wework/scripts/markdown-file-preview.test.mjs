import assert from 'node:assert/strict'
import test from 'node:test'
import { assertMarkdownPreviewAndSource } from '../e2e/desktop/modules/markdown-file-preview.mjs'

test('Markdown file checks require rendered content, an explicit source switch and source content', async () => {
  const calls = []
  await assertMarkdownPreviewAndSource(
    { command: async (...args) => calls.push(args) },
    'Worktree-only marker',
    { visible: true, timeoutMs: 10000 }
  )
  assert.deepEqual(calls, [
    [
      'waitFor',
      '[data-testid="workspace-markdown-preview"]',
      { visible: true, timeoutMs: 10000, text: 'Worktree-only marker' },
    ],
    ['clickWhenEnabled', '[data-testid="workspace-file-markdown-mode-button"]'],
    [
      'waitFor',
      '[data-testid="workspace-file-editor-content"]',
      { visible: true, timeoutMs: 10000, text: 'Worktree-only marker' },
    ],
  ])
})

test('preview, mode-switch and source failures stop verification without retries', async () => {
  for (const failureStep of [1, 2, 3]) {
    let calls = 0
    const failure = new Error(`Failed step ${failureStep}`)
    const control = {
      command: async () => {
        calls += 1
        if (calls === failureStep) throw failure
      },
    }
    await assert.rejects(assertMarkdownPreviewAndSource(control, 'Expected content'), failure)
    assert.equal(calls, failureStep)
  }
})
