import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from './plugin-regression-fixture.mjs'

export function bundledPluginUpgradeFixture(codexHome, plugins, readyTimeoutMs) {
  const chatPath = join(codexHome, 'sessions', 'bundled-upgrade-preservation.jsonl')
  return {
    async prepare() {
      const configPath = join(codexHome, 'config.toml')
      let config = await readFile(configPath, 'utf8')
      for (const { name, version, sourcePath } of plugins) {
        assert.ok(
          !config.includes(`${name}@wework-personal`),
          'Upgrade fixture requires a fresh isolated Codex Home'
        )
        config += `\n[plugins."${name}@wework-personal"]\nenabled = ${name !== 'wework-space'}\n`
        const cache = join(codexHome, 'plugins/cache/wework-personal', name, version)
        await cp(sourcePath, cache, { recursive: true })
        if (name === 'smart-app-builder') {
          await writeFile(
            join(cache, 'scripts/smart-app-tool.mjs'),
            '// stale same-version builder script\n'
          )
        }
        await writeFile(join(cache, 'obsolete-upgrade-fixture.txt'), 'stale same-version cache')
      }
      await writeFile(configPath, config)
      await mkdir(join(codexHome, 'sessions'), { recursive: true })
      await writeFile(chatPath, 'preserve this conversation\n')
    },
    async verify(control) {
      let lastStates
      try {
        // Startup RPCs can defer cache upgrades, so use the workbench readiness budget.
        await until(
          async () => {
            const result = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
            lastStates = result.states
            return result
          },
          result => plugins.every(({ name }) => result.states[name]?.status === 'ready'),
          'Bundled plugin upgrades did not reach ready',
          readyTimeoutMs
        )
      } catch (cause) {
        throw new Error(
          `Bundled plugin upgrades did not reach ready: ${JSON.stringify(lastStates)}`,
          {
            cause,
          }
        )
      }
      for (const { name, version } of plugins) {
        const result = JSON.parse(
          await control.command('ensureBundledPluginUpdated', 'body', { value: name })
        )
        assert.equal(result.state.status, 'ready', `${name} did not reach ready`)
        const source = join(result.marketplace.path, 'plugins', name)
        const cache = join(codexHome, 'plugins/cache/wework-personal', name, version)
        await assertSameDirectory(source, cache)
      }
      const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
      assert.match(config, /\[plugins\."wework-space@wework-personal"\]\s*enabled\s*=\s*false/)
      assert.equal(await readFile(chatPath, 'utf8'), 'preserve this conversation\n')
    },
    async verifyUninstall(control) {
      const name = 'smart-app-builder'
      await control.command('uninstallInstalledPlugin', 'body', {
        value: `${name}@wework-personal`,
      })
      await assert.rejects(
        control.command('ensureBundledPluginUpdated', 'body', { value: name }),
        /Codex plugin is not installed/
      )
      const observationDeadline = Date.now() + 3_000
      await until(
        async () => {
          await assert.rejects(stat(join(codexHome, 'plugins/cache/wework-personal', name)), {
            code: 'ENOENT',
          })
          const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
          assert.ok(!config.includes(`[plugins."${name}@wework-personal"]`))
          assert.equal(await readFile(chatPath, 'utf8'), 'preserve this conversation\n')
          return Date.now() >= observationDeadline
        },
        finished => finished,
        'Uninstalled bundled plugin was restored by background synchronization'
      )
    },
  }
}

async function assertSameDirectory(source, cache) {
  const sourceEntries = await readdir(source, { withFileTypes: true })
  const cacheEntries = await readdir(cache)
  assert.deepEqual(cacheEntries.sort(), sourceEntries.map(entry => entry.name).sort())
  for (const entry of sourceEntries) {
    if (entry.isDirectory()) {
      await assertSameDirectory(join(source, entry.name), join(cache, entry.name))
    } else {
      assert.ok(entry.isFile(), 'Unexpected source file type')
      assert.deepEqual(
        await readFile(join(cache, entry.name)),
        await readFile(join(source, entry.name)),
        `Cache differs: ${entry.name}`
      )
    }
  }
}
