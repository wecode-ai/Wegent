import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { managedRoot } from '../e2e/desktop/modules/managed-plugin-root.mjs'

const homes = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wework-managed-root-'))
  homes.push(home)
  await mkdir(join(home, 'capabilities'))
  await writeFile(
    join(home, 'capabilities/manifest-v2.json'),
    JSON.stringify({
      plugins: {
        fixture: {
          installed_plugin_id: 71,
          managed: true,
          enabled: true,
          store_path: 'store/fixture',
          runtime: { codex_link: '../codex/runtime' },
        },
      },
    })
  )
  return { home, root: join(home, 'codex/runtime') }
}

test('waits for a runtime directory that is being published without accepting a missing copy', async () => {
  const { home, root } = await fixture()
  await expect(managedRoot(home, 71)).resolves.toBeNull()
  await mkdir(root, { recursive: true })
  await expect(managedRoot(home, 71)).resolves.toBe(root)
})

test('still rejects a symlink instead of accepting it as a managed runtime copy', async () => {
  const { home, root } = await fixture()
  const external = join(home, 'external')
  await mkdir(external)
  await mkdir(join(home, 'codex'))
  await symlink(external, root, 'dir')
  await expect(managedRoot(home, 71)).rejects.toThrow('Expected a real runtime copy')
})

test('propagates filesystem errors other than a not-yet-published runtime', async () => {
  const { home } = await fixture()
  await writeFile(join(home, 'codex'), 'not a directory')
  await expect(managedRoot(home, 71)).rejects.toMatchObject({ code: 'ENOTDIR' })
})
