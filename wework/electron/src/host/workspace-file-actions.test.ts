import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { HostCapabilityRouter } from './capability-router.js'
import {
  getFileGitHostedTarget,
  gitHostedFileTarget,
  registerWorkspaceFileActions,
} from './workspace-file-actions.js'

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  save: vi.fn(),
  writeText: vi.fn(),
  git: vi.fn(),
}))
vi.mock('electron', () => ({
  clipboard: { writeText: mocks.writeText },
  dialog: { showSaveDialog: mocks.save },
}))
vi.mock('node:fs/promises', () => ({
  copyFile: mocks.copyFile,
  readFile: mocks.readFile,
  stat: mocks.stat,
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_command: string, args: string[]) => ({
      stdout: mocks.git(args),
      stderr: '',
    }),
  }),
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockResolvedValue({ isFile: () => true })
})

describe('workspace file actions', () => {
  test.each([
    [
      'git@github.com:team/repo.git',
      'github',
      'https://github.com/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'https://github.com/team/repo.git',
      'github',
      'https://github.com/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'ssh://git@github.com/team/repo.git',
      'github',
      'https://github.com/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'git@github.enterprise.test:team/repo.git',
      'github',
      'https://github.enterprise.test/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'https://github.enterprise.test:8443/team/repo.git',
      'github',
      'https://github.enterprise.test:8443/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'ssh://git@github.enterprise.test:2222/team/repo.git',
      'github',
      'https://github.enterprise.test/team/repo/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'git@gitlab.com:team/repo.git',
      'gitlab',
      'https://gitlab.com/team/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'ssh://git@gitlab.example.test:123456/group/subgroup/repo.git',
      'gitlab',
      'https://gitlab.example.test/group/subgroup/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'https://gitlab.example.test:8443/group/repo.git',
      'gitlab',
      'https://gitlab.example.test:8443/group/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'ssh://git@host:123456/group/repo.git',
      'git',
      'https://host/group/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'git@host:group/repo.git',
      'git',
      'https://host/group/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'https://host/group/repo.git',
      'git',
      'https://host/group/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
    [
      'https://example.test/team/repo.git',
      'git',
      'https://example.test/team/repo/-/blob/feature%2Fmenu/docs/a%20b.md',
    ],
  ])(
    'builds a hosted file link from %s without losing spaces or branch slashes',
    (remote, provider, expected) => {
      expect(gitHostedFileTarget(remote, 'feature/menu', 'docs/a b.md')).toEqual({
        provider,
        url: expected,
      })
    }
  )
  test.each([
    'git@gitlab.com:team.git',
    'file:///repo',
    'not-a-remote',
    'https://github.com/team',
    'https://github.com/team/nested/repo.git',
    'ssh://user@host:22/group/repo.git',
    'https://host/group/repo',
  ])('does not invent hosted links for unsupported remotes %s', remote => {
    expect(gitHostedFileTarget(remote, 'main', 'a.ts')).toBeNull()
  })
  test('uses the owning repository and detached commit, and refuses untracked files', async () => {
    mocks.git.mockImplementation((args: string[]) => {
      const command = args.slice(2).join(' ')
      return (
        {
          'rev-parse --show-toplevel': '/fixture/repo',
          'ls-files --error-unmatch -- :(literal)a.ts': '',
          'remote get-url origin': 'git@github.com:team/repo.git',
          'rev-parse --abbrev-ref HEAD': 'HEAD',
          'rev-parse HEAD': 'abc123',
        } as Record<string, string>
      )[command]
    })
    expect(await getFileGitHostedTarget('/fixture/repo/src/a.ts')).toEqual({
      provider: 'github',
      url: 'https://github.com/team/repo/blob/abc123/src/a.ts',
    })
    mocks.git.mockImplementation(() => {
      throw new Error('untracked')
    })
    expect(await getFileGitHostedTarget('/fixture/repo/src/new.ts')).toBeNull()
  })
  const setup = () => {
    const router = new HostCapabilityRouter()
    router.grant('test', ['workspace.saveFileAs', 'workspace.copyFileContents'])
    registerWorkspaceFileActions(router, () => ({}) as BrowserWindow)
    return router
  }
  test('save cancellation writes nothing; an accepted destination copies the original bytes', async () => {
    const router = setup()
    mocks.save
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, filePath: '/fixture/export/a.pdf' })
    await router.invoke('test', 'workspace.saveFileAs', { path: '/fixture/repo/a.pdf' })
    expect(mocks.copyFile).not.toHaveBeenCalled()
    await router.invoke('test', 'workspace.saveFileAs', { path: '/fixture/repo/a.pdf' })
    expect(mocks.copyFile).toHaveBeenCalledExactlyOnceWith(
      '/fixture/repo/a.pdf',
      '/fixture/export/a.pdf'
    )
  })
  test('copies full text from disk and rejects directories', async () => {
    const router = setup()
    mocks.readFile.mockResolvedValue('complete file contents')
    await router.invoke('test', 'workspace.copyFileContents', { path: '/fixture/repo/a.ts' })
    expect(mocks.writeText).toHaveBeenCalledWith('complete file contents')
    mocks.stat.mockResolvedValue({ isFile: () => false })
    await expect(
      router.invoke('test', 'workspace.copyFileContents', { path: '/fixture/repo' })
    ).rejects.toThrow('regular file')
  })
})
