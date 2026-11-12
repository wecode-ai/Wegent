import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldLightweightWorkbench } from './smart-app-scaffold.js'
import { validateSmartAppPackageDirectory } from './smart-app-package-validator.js'
import {
  importLegacyLightApp,
  readLegacyLightAppData,
  readLegacyLightApps,
} from './legacy-light-app-import.js'
import { WorkbenchAppDataStore } from './workbench-app-data.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-lightweight-dsh-'))
  roots.push(root)
  await scaffoldLightweightWorkbench({
    path: root,
    name: 'calculator',
    displayName: 'Calculator',
    description: 'A local calculator',
    dshVersion: '0.2.0-rc.2',
    nativeCapabilities: ['clipboard.write'],
    html: '<button id="add">Add</button><script>window.test=window.weworkWorkbench</script>',
  })
  return { root, bundle: join(root, 'packages/bundle/calculator') }
}

describe('lightweight DSH workbenches', () => {
  test('generates an executable DSH project whose user HTML has only the isolated SDK', async () => {
    const { root, bundle } = await fixture()
    await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root })
    const { manifest } = await validateSmartAppPackageDirectory(root, { developmentSource: true })
    expect(manifest).toMatchObject({
      type: 'deepseek-harness-plugin-bundle',
      flavor: 'lightweight',
      capabilities: { native: ['clipboard.write'] },
    })
    const client = await readFile(join(bundle, 'client.js'), 'utf8')
    expect(client).toContain("sandbox: 'allow-scripts'")
    expect(client).not.toContain('allow-same-origin')
    expect(client).toContain('window.weworkWorkbench')
    expect(client).toContain("event.origin !== 'null'")
    await execFileAsync(process.execPath, ['scripts/typecheck.mjs'], { cwd: root })
    await execFileAsync(process.execPath, ['--test'], { cwd: root })
  })

  test.each(['host', 'client', 'patch', 'metadata'] as const)(
    'rejects a modified %s before DSH can execute it',
    async target => {
      const { root, bundle } = await fixture()
      if (target === 'host')
        await writeFile(
          join(bundle, 'index.js'),
          "import fs from 'node:fs'; export function apply(){ fs.writeFileSync('/tmp/escape','yes') }"
        )
      if (target === 'client')
        await writeFile(
          join(bundle, 'client.js'),
          "window.__ModuleLoader__.load({id:'evil',factory:()=>{parent.location='https://example.com'}})"
        )
      if (target === 'patch')
        await writeFile(join(bundle, 'cordis.patch.yml'), '- insert:\n    - name: evil-host\n')
      if (target === 'metadata') {
        const path = join(bundle, 'package.json')
        const metadata = JSON.parse(await readFile(path, 'utf8'))
        metadata.scripts = { postinstall: 'node evil.js' }
        await writeFile(path, JSON.stringify(metadata))
      }
      await expect(validateSmartAppPackageDirectory(root)).rejects.toThrow(/Lightweight/)
    }
  )

  test('builds local CSS, images and script assets without exposing a same-origin resource URL', async () => {
    const { root, bundle } = await fixture()
    await writeFile(
      join(root, 'view.html'),
      '<link rel="stylesheet" href="theme.css"><img src="icon.svg"><script src="app.js"></script>'
    )
    await writeFile(join(root, 'theme.css'), 'body{background:url("icon.svg")}')
    await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(root, 'app.js'), 'window.answer=42')
    await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root })
    await expect(validateSmartAppPackageDirectory(root)).resolves.toBeDefined()
    expect(await readFile(join(bundle, 'client.js'), 'utf8')).toContain(
      'data:text/javascript;base64,'
    )
  })

  test('rebuilds edited linked pages through trusted Host generation without executing project scripts', async () => {
    const { root, bundle } = await fixture()
    await writeFile(join(root, 'view.html'), '<main>Updated linked page</main>')
    await writeFile(
      join(root, 'scripts/build.mjs'),
      "throw new Error('Untrusted script must not execute')"
    )
    await expect(validateSmartAppPackageDirectory(root)).rejects.toThrow('Client bridge differs')
    await expect(
      validateSmartAppPackageDirectory(root, { developmentSource: true })
    ).resolves.toBeDefined()
    expect(await readFile(join(bundle, 'client.js'), 'utf8')).toContain('Updated linked page')
    await expect(validateSmartAppPackageDirectory(root)).resolves.toBeDefined()
    await writeFile(join(bundle, 'index.js'), 'export function apply() { process.exit(1) }')
    await expect(
      validateSmartAppPackageDirectory(root, { developmentSource: true })
    ).rejects.toThrow('trusted no-op')
  })

  test('rejects remote resources and path traversal instead of silently weakening the sandbox', async () => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'view.html'),
      '<script src="https://example.com/remote.js"></script>'
    )
    await expect(
      execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root })
    ).rejects.toThrow('local assets')
    await writeFile(join(root, 'view.html'), '<script src="../secret.js"></script>')
    await expect(
      execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root })
    ).rejects.toThrow('escapes its project')
  })

  test('imports legacy source, ordinary state and shortcut metadata without deleting or overwriting source', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wework-legacy-lightweight-'))
    roots.push(base)
    const source = join(base, 'legacy')
    const dataDirectory = join(base, 'profile')
    await mkdir(source)
    const legacy = {
      id: 'old-todo',
      name: 'Old TODO',
      description: 'Keep my tasks',
      entry: 'index.html',
      capabilities: ['notifications'],
      window: { width: 380, height: 520, alwaysOnTop: true },
    }
    await writeFile(join(source, 'light-app.json'), JSON.stringify(legacy))
    await writeFile(join(source, 'index.html'), '<script src="app.js"></script>')
    await writeFile(join(source, 'app.js'), 'window.weworkLightApp.storage.get()')
    const records = [
      {
        manifest: legacy,
        packagePath: source,
        installedAt: '2026-01-01T00:00:00Z',
        shortcut: 'CommandOrControl+Shift+T',
      },
    ]
    const data = {
      state: { tasks: ['Real user data'] },
      reminders: [
        { id: 'old-alarm', title: 'Past reminder', body: '', at: '2026-01-01T00:00:00.000Z' },
      ],
    }
    await mkdir(join(dataDirectory, 'light-apps/data'), { recursive: true })
    await writeFile(join(dataDirectory, 'light-apps/registry.json'), JSON.stringify(records))
    await writeFile(join(dataDirectory, 'light-apps/data/old-todo.json'), JSON.stringify(data))
    const destination = join(base, 'imported')
    const imported = await importLegacyLightApp(source, destination, '0.2.0-rc.2')
    expect(imported.name).toBe('old-todo')
    await expect(validateSmartAppPackageDirectory(destination)).resolves.toBeDefined()
    expect(await readLegacyLightApps(dataDirectory)).toEqual(records)
    const store = new WorkbenchAppDataStore(dataDirectory)
    await store.importLegacy(imported.name, await readLegacyLightAppData(dataDirectory, legacy.id))
    expect(await store.read(imported.name)).toEqual({ state: data.state })
    expect(await readFile(join(source, 'app.js'), 'utf8')).toContain('weworkLightApp')
    expect(await readFile(join(destination, 'view.html'), 'utf8')).toContain(
      Buffer.from('window.weworkWorkbench.storage.get()').toString('base64')
    )
    await store.commit(imported.name, { tasks: ['New data'] })
    await expect(store.importLegacy(imported.name, data)).rejects.toThrow('already exists')
    expect((await store.read(imported.name)).state).toEqual({ tasks: ['New data'] })
    expect(
      JSON.parse(await readFile(join(dataDirectory, 'light-apps/data/old-todo.json'), 'utf8'))
    ).toEqual(data)
  })

  test('rejects symlinked or sensitive legacy assets and destinations that resolve into the source', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wework-legacy-import-safety-'))
    roots.push(base)
    const source = join(base, 'source')
    await mkdir(source)
    await writeFile(join(source, 'light-app.json'), JSON.stringify({ id: 'notes', name: 'Notes' }))
    await writeFile(join(source, 'index.html'), '<main>Keep this source</main>')
    await writeFile(join(base, 'private.txt'), 'private')
    await symlink(join(base, 'private.txt'), join(source, 'secret.txt'))
    await expect(importLegacyLightApp(source, join(base, 'output'), '0.2.0-rc.2')).rejects.toThrow(
      'symbolic links'
    )
    await rm(join(source, 'secret.txt'))
    await writeFile(join(source, '.env'), 'PRIVATE=value')
    await expect(
      importLegacyLightApp(source, join(base, 'other-output'), '0.2.0-rc.2')
    ).rejects.toThrow('sensitive')
    await rm(join(source, '.env'))
    const alias = join(base, 'source-alias')
    await symlink(source, alias, 'dir')
    await expect(importLegacyLightApp(source, alias, '0.2.0-rc.2')).rejects.toThrow(
      'outside its source'
    )
    expect(await readFile(join(source, 'index.html'), 'utf8')).toBe('<main>Keep this source</main>')
  })
})
