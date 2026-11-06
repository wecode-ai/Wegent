import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createDingTalkReplyStory } from '../e2e/desktop/modules/stand-in-dingtalk-reply-story.mjs'

const roots = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('uses the prepared reply binary with scenario-local protocol state and no compiler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-dingtalk-reply-'))
  roots.push(root)
  const prepared = join(root, 'prepared.exe')
  const bytes = Buffer.from('prepared native reply fixture')
  await writeFile(prepared, bytes)
  vi.stubEnv('WEWORK_E2E_DWS_REPLY_FIXTURE_BIN', prepared)
  vi.stubEnv('PATH', '')
  const story = createDingTalkReplyStory({ resultDir: root })
  const context = { appEnvironment: {} }
  const baseline = {
    async prepareApp(value) {
      value.appEnvironment.DWS_BINARY_PATH = 'original-dws-binary'
    },
  }

  await story.prepareApp(context, baseline)

  const binary = join(
    root,
    process.platform === 'win32' ? 'source-story-dws.exe' : 'source-story-dws'
  )
  expect(context.appEnvironment.DWS_BINARY_PATH).toBe(binary)
  expect(await readFile(binary)).toEqual(bytes)
  expect(await readFile(join(root, 'dingtalk-story/baseline-path.txt'), 'utf8')).toBe(
    'original-dws-binary'
  )
  expect(await readFile(join(root, 'dingtalk-story/replies.jsonl'), 'utf8')).toBe('')
  expect(await readFile(prepared)).toEqual(bytes)
})
