import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { materializeBundledPluginResources } from './lib/bundled-plugin-resources.mjs'

let fixtureRoot

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

describe('bundled plugin resources', () => {
  test('projects a nested official Codex plugin from its outer Wework package', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'wework-bundled-plugin-resources-'))
    const weworkRoot = join(fixtureRoot, 'wework')
    const destination = join(fixtureRoot, 'resources')
    const marketplaceRoot = join(weworkRoot, 'resources', 'bundled-plugins', 'wework-personal')
    const marketplace = {
      name: 'wework-personal',
      plugins: [
        {
          name: 'developer',
          source: { source: 'local', path: './plugins/developer' },
        },
      ],
    }
    await json(join(marketplaceRoot, '.agents/plugins/marketplace.json'), marketplace)
    await json(join(marketplaceRoot, '.claude-plugin/marketplace.json'), {
      name: 'wework-personal',
      plugins: [{ name: 'developer', source: './plugins/developer' }],
    })
    await json(join(weworkRoot, 'dsh/developer/package.json'), {
      name: '@wework/developer',
      wework: { codexPlugin: './codex-plugin' },
    })
    await json(join(weworkRoot, 'dsh/developer/codex-plugin/.codex-plugin/plugin.json'), {
      name: 'developer',
      version: '0.1.1',
      skills: './skills/',
    })
    await file(
      join(weworkRoot, 'dsh/developer/codex-plugin/skills/develop/SKILL.md'),
      [
        '---',
        'name: develop',
        'description: Develop a Wework plugin.',
        '---',
        '[Catalog](references/extension-points.md)',
        '[Demo](assets/ui-extension-demo)',
        '',
      ].join('\n')
    )
    await file(
      join(weworkRoot, 'dsh/developer/codex-plugin/skills/develop/references/extension-points.md'),
      '# Extension points\n'
    )
    await file(
      join(
        weworkRoot,
        'dsh/developer/codex-plugin/skills/develop/assets/ui-extension-demo/client.js'
      ),
      "export const demo = 'usable'\n"
    )

    await materializeBundledPluginResources(weworkRoot, destination)

    await expect(
      readFile(
        join(destination, 'wework-personal/plugins/developer/.codex-plugin/plugin.json'),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({ name: 'developer', version: '0.1.1' })
    await expect(
      readFile(
        join(destination, 'wework-personal/plugins/developer/skills/develop/SKILL.md'),
        'utf8'
      )
    ).resolves.toContain('Develop a Wework plugin.')
    await expect(
      readFile(
        join(
          destination,
          'wework-personal/plugins/developer/skills/develop/references/extension-points.md'
        ),
        'utf8'
      )
    ).resolves.toContain('Extension points')
    await expect(
      readFile(
        join(
          destination,
          'wework-personal/plugins/developer/skills/develop/assets/ui-extension-demo/client.js'
        ),
        'utf8'
      )
    ).resolves.toContain("demo = 'usable'")
  })
})

async function file(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function json(path, value) {
  await file(path, `${JSON.stringify(value)}\n`)
}
