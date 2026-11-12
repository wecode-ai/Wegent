import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { normalizeWorkbenchShortcut, WorkbenchDesktopShortcuts } from './workbench-shortcuts.js'

const roots: string[] = []
const launch = {
  command: process.execPath,
  args: [],
  environment: { WEWORK_USER_DATA_DIR: '/owner/profile' },
}
const execFileAsync = promisify(execFile)
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
describe('workbench shortcuts', () => {
  test('normalizes aliases and requires a real global modifier', () => {
    expect(normalizeWorkbenchShortcut('option+CMD+k')).toBe('Alt+Command+K')
    expect(normalizeWorkbenchShortcut('ctrl+f1')).toBe('Control+F1')
    expect(normalizeWorkbenchShortcut('ctrl+SPACE')).toBe('Control+Space')
    for (const value of [
      'K',
      'Shift+K',
      'Command+Command+K',
      'Control+../../x',
      'Control+',
      'Control+Alt+F25',
    ])
      expect(() => normalizeWorkbenchShortcut(value)).toThrow()
  })
  test('desktop links use the stable installation scheme and never overwrite unrelated content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcuts-'))
    roots.push(root)
    const desktop = join(root, 'Desktop')
    const links = new WorkbenchDesktopShortcuts(desktop, launch, 'win32')
    const path = await links.create('calculator')
    expect(await readFile(path, 'utf8')).toContain('wework://workbenches/calculator')
    expect(await links.create('calculator')).toBe(path)
    await writeFile(path, 'unrelated desktop item')
    await expect(links.create('calculator')).rejects.toThrow('occupied')
    await links.remove('calculator')
    expect(await readFile(path, 'utf8')).toBe('unrelated desktop item')
    await expect(links.create('../elsewhere')).rejects.toThrow('installation id')
  })
  test('uninstall preserves a symlink occupying the shortcut path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-owner-'))
    roots.push(root)
    const desktop = join(root, 'Desktop')
    await mkdir(desktop)
    const links = new WorkbenchDesktopShortcuts(desktop, launch, 'linux')
    const path = await links.create('notes')
    const target = join(root, 'important')
    await writeFile(target, 'personal data')
    await rm(path)
    await symlink(target, path)
    await links.remove('notes')
    expect(await readFile(path, 'utf8')).toBe('personal data')
    expect(await readFile(target, 'utf8')).toBe('personal data')
  })

  test('macOS creates an executable application bound to the exact instance and arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-macos-shortcut-'))
    roots.push(root)
    const record = join(root, 'invocation.json')
    const recorder = join(root, "host ' $(should-not-execute).mjs")
    await writeFile(
      recorder,
      `import { writeFile } from 'node:fs/promises';
       await writeFile(process.argv[2], JSON.stringify({
         args: process.argv.slice(3),
         profile: process.env.WEWORK_USER_DATA_DIR,
         electronNode: process.env.ELECTRON_RUN_AS_NODE,
         release: process.env.WEWORK_ACTIVE_RELEASE_ID,
       }));`
    )
    const profile = join(root, "profile ' $(should-not-execute)")
    const links = new WorkbenchDesktopShortcuts(
      join(root, 'Desktop'),
      {
        command: process.execPath,
        args: [recorder, record],
        environment: { WEWORK_USER_DATA_DIR: profile },
      },
      'darwin'
    )
    const path = await links.create('notes')
    expect(path).toBe(join(root, 'Desktop', 'notes.app'))
    const executable = join(path, 'Contents', 'MacOS', 'launch-workbench')
    expect((await stat(executable)).mode & 0o700).toBe(0o700)
    await execFileAsync(executable, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WEWORK_ACTIVE_RELEASE_ID: 'old-release' },
    })
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      args: ['wework://workbenches/notes'],
      profile,
    })
    expect(await links.create('notes')).toBe(path)
    const plist = await readFile(join(path, 'Contents/Info.plist'), 'utf8')
    expect(plist).toContain('<key>CFBundlePackageType</key><string>APPL</string>')
    expect(plist).toContain('<key>CFBundleExecutable</key><string>launch-workbench</string>')
    await links.remove('notes')
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('replaces only the exact obsolete macOS web bookmark after creating the application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-migration-'))
    roots.push(root)
    const oldPath = join(root, 'notes.webloc')
    await writeFile(
      oldPath,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>wework://workbenches/notes</string></dict></plist>\n'
    )
    const links = new WorkbenchDesktopShortcuts(root, launch, 'darwin')
    const path = await links.create('notes')
    await expect(access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(path)).isDirectory()).toBe(true)
    await writeFile(oldPath, 'personal web bookmark')
    await links.remove('notes')
    expect(await readFile(oldPath, 'utf8')).toBe('personal web bookmark')
  })

  test('preserves another instance and user additions inside a macOS shortcut', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-instance-'))
    roots.push(root)
    const links = new WorkbenchDesktopShortcuts(root, launch, 'darwin')
    const path = await links.create('notes')
    const other = new WorkbenchDesktopShortcuts(
      root,
      { ...launch, environment: { WEWORK_USER_DATA_DIR: '/other/profile' } },
      'darwin'
    )
    await expect(other.create('notes')).rejects.toThrow('occupied')
    await other.remove('notes')
    expect((await stat(path)).isDirectory()).toBe(true)
    await writeFile(join(path, 'personal.txt'), 'personal data')
    await expect(links.create('notes')).rejects.toThrow('occupied')
    await links.remove('notes')
    expect(await readFile(join(path, 'personal.txt'), 'utf8')).toBe('personal data')
  })

  test('removal identifies the owning profile across refreshed launch environments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-profile-'))
    roots.push(root)
    const links = new WorkbenchDesktopShortcuts(root, launch, 'darwin')
    const path = await links.create('notes')
    const restored = new WorkbenchDesktopShortcuts(
      root,
      {
        ...launch,
        environment: { ...launch.environment, WEWORK_HARNESS_RESOURCE_ROOT: '/new/runtime' },
      },
      'darwin'
    )
    await restored.remove('notes')
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('recreation atomically refreshes the owning instance executable and environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-refresh-'))
    roots.push(root)
    const path = await new WorkbenchDesktopShortcuts(root, launch, 'darwin').create('notes')
    const plist = await readFile(join(path, 'Contents/Info.plist'), 'utf8')
    const refreshed = new WorkbenchDesktopShortcuts(
      root,
      {
        command: '/new/Wework',
        args: ['/current/source'],
        environment: { ...launch.environment, WEWORK_HARNESS_RESOURCE_ROOT: '/current/runtime' },
      },
      'darwin'
    )
    expect(await refreshed.create('notes')).toBe(path)
    const script = await readFile(join(path, 'Contents/MacOS/launch-workbench'), 'utf8')
    expect(script).toContain("exec '/new/Wework' '/current/source' 'wework://workbenches/notes'")
    expect(script).toContain("export WEWORK_HARNESS_RESOURCE_ROOT='/current/runtime'")
    expect(await readFile(join(path, 'Contents/Info.plist'), 'utf8')).toBe(plist)
    await writeFile(join(path, 'Contents/MacOS/launch-workbench'), 'user modified executable')
    await expect(refreshed.create('notes')).rejects.toThrow('occupied')
    await refreshed.remove('notes')
    expect(await readFile(join(path, 'Contents/MacOS/launch-workbench'), 'utf8')).toBe(
      'user modified executable'
    )
  })

  test('never follows a macOS application or bundle entry symlink during removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shortcut-app-owner-'))
    roots.push(root)
    const desktop = join(root, 'Desktop')
    const links = new WorkbenchDesktopShortcuts(desktop, launch, 'darwin')
    const path = await links.create('notes')
    const other = join(root, 'Other.app')
    await mkdir(other)
    await writeFile(join(other, 'personal.txt'), 'personal data')
    await rm(path, { recursive: true })
    await symlink(other, path)
    await expect(links.create('notes')).rejects.toThrow('occupied')
    await links.remove('notes')
    expect(await readFile(join(path, 'personal.txt'), 'utf8')).toBe('personal data')
  })
})
