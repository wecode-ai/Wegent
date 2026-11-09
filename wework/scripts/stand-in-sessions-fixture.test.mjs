// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-sessions.scenario.mjs'

describe('stand-in session provider-switch fixture', () => {
  test('uses the built-in provider instead of a custom provider with the same GPT alias', async () => {
    const scenario = createDesktopScenario({})
    expect(scenario.modelProviderId).toBe('openai')
    const codexHome = await mkdtemp(join(tmpdir(), 'stand-in-sessions-fixture-'))
    try {
      const configPath = join(codexHome, 'config.toml')
      const config = `model_provider = "${scenario.modelProviderId}"\nmodel = "${scenario.modelId}"\n`
      await writeFile(configPath, config)
      await scenario.prepareApp({ codexHome, control: { url: 'http://127.0.0.1:43111' } })
      expect(await readFile(configPath, 'utf8')).toBe(
        `openai_base_url = "http://127.0.0.1:43111/v1"\n${config}`
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
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
