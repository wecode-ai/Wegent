import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { clearStartupRuntimeFiles, clearStartupUserFiles } from './startup-recovery-files.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-recovery-'))
  roots.push(root)
  const paths = {
    dataDirectory: join(root, 'user-data'),
    codexHome: join(root, 'codex'),
    claudeHome: join(root, 'claude'),
    capabilitiesHome: join(root, 'capabilities'),
  }
  const profile = join(paths.dataDirectory, 'dsh-core/profiles/wework-core')
  const contents = {
    [join(profile, '.wework-runtime.json')]: 'damaged runtime stamp',
    [join(profile, 'node_modules/@wegent/dsh-app-wework/index.js')]: 'managed runtime',
    [join(profile, 'node_modules/user-plugin/index.js')]: 'user plugin',
    [join(profile, 'package.json')]: '{"dependencies":{"user-plugin":"1.0"}}',
    [join(profile, '.wework-core-plugins.json')]: '{"disabled":["user-plugin"]}',
    [join(paths.dataDirectory, 'managed-components/state.json')]: 'damaged component state',
    [join(paths.dataDirectory, 'renderer-local-storage.json')]: 'layout and sign-in',
    [join(paths.codexHome, 'sessions/task.jsonl')]: 'conversation',
    [join(paths.codexHome, 'plugins/installed.json')]: 'installed plugin',
    [join(paths.codexHome, 'config.toml')]: 'model settings',
    [join(paths.claudeHome, 'plugins/installed_plugins.json')]: 'installed plugin',
    [join(root, 'data/tasks.db')]: 'tasks',
    [join(root, 'workspace/project/index.ts')]: 'project source',
    [join(root, 'shared/plugins/source.ts')]: 'shared plugin source',
    [join(paths.capabilitiesHome, 'manifest-v2.json')]: JSON.stringify({
      version: 2,
      skills: { skill: {} },
      mcps: { server: {} },
      plugins: { plugin: {} },
    }),
  }
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return { root, paths, profile, contents }
}

describe('startup recovery file boundaries', () => {
  test('removes rebuildable runtime files while preserving plugins and user data', async () => {
    const { paths, profile, contents } = await fixture()
    await clearStartupRuntimeFiles(paths.dataDirectory)
    for (const [path, content] of Object.entries(contents)) {
      if (
        path.includes('managed-components') ||
        path.endsWith('.wework-runtime.json') ||
        path.includes(join('node_modules', '@wegent', 'dsh-app-wework'))
      ) {
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(path, 'utf8')).toBe(content)
      }
    }
    expect(await readFile(join(profile, 'node_modules/user-plugin/index.js'), 'utf8')).toBe(
      'user plugin'
    )
  })

  test('clears installed plugins and settings while retaining tasks, sessions, and sources', async () => {
    const { paths, root, profile } = await fixture()
    const authSource = join(root, 'native-auth.json')
    await writeFile(authSource, 'synthetic authentication')
    await symlink(authSource, join(paths.codexHome, 'auth.json'))

    await clearStartupUserFiles(paths)

    for (const path of [
      join(profile, 'package.json'),
      join(paths.codexHome, 'config.toml'),
      join(paths.codexHome, 'plugins/installed.json'),
      join(paths.codexHome, 'auth.json'),
      join(paths.claudeHome, 'plugins/installed_plugins.json'),
    ]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const [path, content] of [
      [join(paths.codexHome, 'sessions/task.jsonl'), 'conversation'],
      [join(root, 'data/tasks.db'), 'tasks'],
      [join(root, 'workspace/project/index.ts'), 'project source'],
      [join(root, 'shared/plugins/source.ts'), 'shared plugin source'],
      [authSource, 'synthetic authentication'],
    ])
      expect(await readFile(path, 'utf8')).toBe(content)
    expect(
      JSON.parse(await readFile(join(paths.capabilitiesHome, 'manifest-v2.json'), 'utf8'))
    ).toEqual({
      version: 2,
      skills: { skill: {} },
      mcps: { server: {} },
      plugins: {},
    })
    await expect(clearStartupUserFiles(paths)).resolves.toBeUndefined()
  })

  test('repairs a corrupt plugin registry without deleting task data', async () => {
    const { paths, root } = await fixture()
    const manifest = join(paths.capabilitiesHome, 'manifest-v2.json')
    await writeFile(manifest, 'damaged registry')

    await clearStartupUserFiles(paths)

    expect(JSON.parse(await readFile(manifest, 'utf8')).plugins).toEqual({})
    expect(await readFile(join(root, 'data/tasks.db'), 'utf8')).toBe('tasks')
  })

  test('rejects an agent Home alias into personal data before deleting settings', async () => {
    const { paths, root } = await fixture()
    const alias = join(root, 'agent-alias')
    await symlink(paths.codexHome, alias, 'junction')

    await expect(
      clearStartupUserFiles({ ...paths, codexHome: alias, protectedAgentHomes: [paths.codexHome] })
    ).rejects.toThrow('Personal agent Homes')

    expect(await readFile(join(paths.codexHome, 'config.toml'), 'utf8')).toBe('model settings')
  })
})
