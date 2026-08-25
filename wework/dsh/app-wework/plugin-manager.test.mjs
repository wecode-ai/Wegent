import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CoreDshPluginManager, parseBlockedBuildMatcher } from './plugin-manager.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-dsh-plugins-'))
  const profileRoot = join(root, 'profiles', 'wework-core')
  await mkdir(profileRoot, { recursive: true })
  await writeFile(
    join(profileRoot, 'package.json'),
    JSON.stringify({
      dependencies: { '@wegent/dsh-app-wework': 'file:/runtime/app' },
      dsh: { profile: { bundles: ['@wegent/dsh-app-wework'] } },
    })
  )
  await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await mkdir(join(profileRoot, 'node_modules', '@wegent', 'dsh-app-wework'), {
    recursive: true,
  })
  await writeFile(
    join(profileRoot, 'node_modules', '@wegent', 'dsh-app-wework', 'package.json'),
    JSON.stringify({
      name: '@wegent/dsh-app-wework',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  )
  return { root, profileRoot }
}

test('reads built-in plugin inventory', async () => {
  const { root } = await fixture()
  const manager = new CoreDshPluginManager({ dshHome: root })
  const plugins = await manager.inventory()
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].immutable, true)
  assert.equal(plugins[0].active, true)
})

test('allows only the exact git build matcher and retries once', async () => {
  const { root, profileRoot } = await fixture()
  let attempts = 0
  const manager = new CoreDshPluginManager({
    dshHome: root,
    runCommand: async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('blocked'), {
          stderr:
            'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\nallowBuilds:\n  "codeload.github.com/owner/plugin/tar.gz/abc": true\n',
        })
      }
    },
  })
  await manager.runPnpm(['add', 'github:owner/plugin'])
  assert.equal(attempts, 2)
  assert.match(
    await readFile(join(profileRoot, 'pnpm-workspace.yaml'), 'utf8'),
    /"codeload\.github\.com\/owner\/plugin\/tar\.gz\/abc": true/
  )
})

test('does not grant build permission for unrelated failures', async () => {
  const { root, profileRoot } = await fixture()
  const manager = new CoreDshPluginManager({
    dshHome: root,
    runCommand: async () => {
      throw Object.assign(new Error('network failed'), { stderr: 'ECONNRESET' })
    },
  })
  await assert.rejects(manager.runPnpm(['add', 'plugin']), /network failed/)
  assert.doesNotMatch(
    await readFile(join(profileRoot, 'pnpm-workspace.yaml'), 'utf8'),
    /allowBuilds/
  )
})

test('parses no matcher without the pnpm blocker marker', () => {
  assert.equal(parseBlockedBuildMatcher('allowBuilds:\n  package: true'), null)
})
