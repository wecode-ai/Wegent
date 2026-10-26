import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CORE_DSH_VERSION, prepareCoreDshRuntime } from './core-dsh-runtime.js'
import { writeRuntime } from './core-dsh-runtime-fixture.js'
import { temporaryDirectory } from './test-helpers.js'

test('keeps an optional connection plugin disabled when preparing a changed runtime profile', async () => {
  const root = await temporaryDirectory('core-dsh-disabled-connection-')
  try {
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'c')
    const options = {
      runtimeRoot: runtime.root,
      dataDirectory: join(root.path, 'data'),
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
    }
    const launch = await prepareCoreDshRuntime(options)
    const profile = join(launch.dshHome, 'profiles', 'wework-core')
    await writeFile(
      join(profile, '.wework-core-plugins.json'),
      JSON.stringify({
        version: 1,
        order: ['@wegent/dsh-connection-dingtalk'],
        disabled: ['@wegent/dsh-connection-dingtalk'],
      })
    )
    await prepareCoreDshRuntime({
      ...options,
      environment: { ...options.environment, WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64) },
    })
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).not.toContain('@wegent/dsh-connection-dingtalk')
    expect(manifest.dsh.profile.bundles).toContain('@wegent/dsh-connection-runtime')
  } finally {
    await root.remove()
  }
})
