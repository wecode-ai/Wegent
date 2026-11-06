import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createDingTalkReplyStory } from '../e2e/desktop/modules/stand-in-dingtalk-reply-story.mjs'

afterEach(() => vi.unstubAllEnvs())

test('reply story reuses the prepared binary without a compiler in the standard user PATH', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'dingtalk-reply-'))
  try {
    const prepared = join(resultDir, 'prepared-story.exe')
    await writeFile(prepared, 'precompiled protocol fixture')
    vi.stubEnv('WEWORK_E2E_DWS_STORY_FIXTURE_BIN', prepared)
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
