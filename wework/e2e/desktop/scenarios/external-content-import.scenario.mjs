import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE_CONFIG = 'model = "desktop-e2e-imported"\n'
const SOURCE_INSTRUCTIONS = '# Desktop E2E imported instructions\n'
const SOURCE_SKILL = '# Desktop E2E imported skill\n'

export async function createDesktopScenario({ captureScreenshot, executorHome, homePath }) {
  const sourceHome = join(homePath, '.codex')
  const destinationHome = join(executorHome, 'codex')
  await mkdir(join(sourceHome, 'skills', 'external-import-e2e'), { recursive: true })
  await Promise.all([
    writeFile(join(sourceHome, 'config.toml'), SOURCE_CONFIG),
    writeFile(join(sourceHome, 'AGENTS.md'), SOURCE_INSTRUCTIONS),
    writeFile(join(sourceHome, 'skills', 'external-import-e2e', 'SKILL.md'), SOURCE_SKILL),
  ])

  return {
    async verify(control) {
      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="general-external-content-import-button"]')
      await control.command('click', '[data-testid="general-external-content-import-button"]')
      await control.command('waitFor', '[data-testid="external-content-import-dialog"]')
      assert.equal(
        await control.command('getAttribute', '[data-testid="external-content-source-codex"]', {
          value: 'aria-pressed',
        }),
        'true',
        'The external content import dialog did not default to Codex'
      )

      await control.command(
        'clickWhenEnabled',
        '[data-testid="external-content-import-confirm-button"]'
      )
      await control.command('waitFor', '[data-testid="external-content-import-success"]', {
        text: 'Codex',
      })
      await captureScreenshot(
        control,
        'external-content-import-success.png',
        '[data-testid="external-content-import-dialog"]'
      )

      assert.equal(
        await readFile(join(destinationHome, 'config.toml'), 'utf8'),
        SOURCE_CONFIG,
        'Codex config was not imported into the managed home'
      )
      assert.equal(
        await readFile(join(destinationHome, 'AGENTS.md'), 'utf8'),
        SOURCE_INSTRUCTIONS,
        'Codex instructions were not imported into the managed home'
      )
      assert.equal(
        await readFile(join(destinationHome, 'skills', 'external-import-e2e', 'SKILL.md'), 'utf8'),
        SOURCE_SKILL,
        'Codex skills were not imported into the managed home'
      )
    },

    diagnostics() {
      return { externalContentImport: true }
    },
  }
}
