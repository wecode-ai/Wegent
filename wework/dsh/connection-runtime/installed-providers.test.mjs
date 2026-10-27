import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConnections } from '../plugin-runtime/connections.js'
import { installedProviders } from './installed-providers.js'

test('lists disabled installed connection manifests without running their entrypoints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wework-connection-catalog-'))
  try {
    const root = join(home, 'profiles', 'wework-core')
    const plugin = join(root, 'node_modules', '@test', 'mail')
    await mkdir(plugin, { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@test/mail': '1.0.0' }, dsh: { profile: { bundles: [] } } })
    )
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: '@test/mail',
        main: 'must-not-run.js',
        wework: {
          connections: {
            apiVersion: 1,
            dependencies: {},
            providers: [
              {
                id: 'inbox',
                displayName: 'Email',
                uses: [],
                resourceKinds: ['folder'],
                resourceLabels: { folder: 'Folder' },
                eventTypes: ['mail.received'],
                collectionModes: ['poll'],
              },
            ],
          },
        },
      })
    )
    await writeFile(join(plugin, 'must-not-run.js'), "throw new Error('Disabled plugin executed')")
    const catalog = await installedProviders(home, [], parseConnections)
    assert.equal(catalog[0].id, '@test/mail/inbox')
    assert.equal(catalog[0].availability.status, 'plugin_disabled')
    assert.deepEqual(
      await installedProviders(
        home,
        [{ packageName: '@test/mail', id: 'active' }],
        parseConnections
      ),
      [{ packageName: '@test/mail', id: 'active' }]
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
