// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-sessions.scenario.mjs'

describe('stand-in session provider-switch fixture', () => {
  test('uses the built-in provider instead of a custom provider with the same GPT alias', async () => {
    const scenario = createDesktopScenario({})
    expect(scenario.modelProviderId).toBe('openai')
    const executorHome = await mkdtemp(join(tmpdir(), 'stand-in-sessions-fixture-'))
    const codexHome = join(executorHome, 'codex')
    await mkdir(codexHome, { recursive: true })
    try {
      const configPath = join(codexHome, 'config.toml')
      const config = `model_provider = "${scenario.modelProviderId}"\nmodel = "${scenario.modelId}"\n`
      await writeFile(configPath, config)
      await scenario.prepareApp({
        codexHome,
        executorHome,
        control: { url: 'http://127.0.0.1:43111' },
      })
      expect(await readFile(configPath, 'utf8')).toBe(
        `openai_base_url = "http://127.0.0.1:43111/v1"\n${config}`
      )
      expect(
        JSON.parse(
          await readFile(join(executorHome, 'capabilities', 'model-catalog-overrides.json'), 'utf8')
        )
      ).toEqual([
        {
          slug: 'gpt-5.5',
          fields: { experimental_supported_tools: ['request_user_input_async'] },
        },
      ])
    } finally {
      await rm(executorHome, { recursive: true, force: true })
    }
  })

  test('still rejects a provider switch without bridged readable history', async () => {
    const request = Readable.from([
      JSON.stringify({ input: [{ role: 'user', content: 'STAND_IN_SESSION_UI_PROVIDER_SWITCH' }] }),
    ])
    request.method = 'POST'
    await expect(
      createDesktopScenario({}).handleHttp(request, {}, new URL('http://localhost/v1/responses'))
    ).rejects.toThrow('Provider transitions must bridge readable reference context')
  })
})
