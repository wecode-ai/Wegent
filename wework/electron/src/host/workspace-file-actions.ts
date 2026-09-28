import { execFile } from 'node:child_process'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, dialog, type BrowserWindow } from 'electron'
import type { HostCapabilityRouter } from './capability-router.js'

const execFileAsync = promisify(execFile)

export interface GitHostedFileTarget {
  provider: 'git' | 'github' | 'gitlab'
  url: string
}

interface GitHostedRemote {
  provider: GitHostedFileTarget['provider']
  repository: string
  webOrigin: string
}

function providerFromHost(host: string): GitHostedFileTarget['provider'] | null {
  const normalized = host.toLowerCase()
  if (normalized.includes('github')) return 'github'
  if (normalized.includes('gitlab')) return 'gitlab'
  return null
}

function gitHostedRemote(remote: string): GitHostedRemote | null {
  const scpMatch = remote.trim().match(/^git@([^:]+):(.+)$/)
  if (scpMatch) {
    const host = scpMatch[1]
    const provider = providerFromHost(host) ?? 'git'
    return {
      provider,
      repository: scpMatch[2],
      webOrigin: `https://${host}`,
    }
  }

  const sshUrlMatch = remote
    .trim()
    .match(/^(?:ssh|git\+ssh):\/\/(?:(git)@)?([^/:]+)(?::\d+)?\/(.+)$/)
  if (sshUrlMatch) {
    const user = sshUrlMatch[1]
    const host = sshUrlMatch[2]
    const provider = providerFromHost(host) ?? (user === 'git' ? 'git' : null)
    if (!provider) return null
    return {
      provider,
      repository: sshUrlMatch[3],
      webOrigin: `https://${host}`,
    }
  }

  let url: URL
  try {
    url = new URL(remote.trim())
  } catch {
    return null
  }

  if (!['https:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null
  const provider =
    providerFromHost(url.hostname) ??
    (url.protocol === 'https:' && url.pathname.endsWith('.git') ? 'git' : null)
  if (!provider) return null
  return {
    provider,
    repository: url.pathname.replace(/^\/+/, ''),
    webOrigin: url.protocol === 'https:' ? `https://${url.host}` : `https://${url.hostname}`,
  }
}

export function gitHostedFileTarget(
  remote: string,
  revision: string,
  path: string
): GitHostedFileTarget | null {
  const remoteParts = gitHostedRemote(remote)
  if (!remoteParts) return null
  const repository = remoteParts.repository.replace(/\.git\/?$/, '').replace(/\/$/, '')
  const repositoryParts = repository.split('/')
  if (
    repositoryParts.length < 2 ||
    repositoryParts.some(part => !part) ||
    (remoteParts.provider === 'github' && repositoryParts.length !== 2) ||
    !revision ||
    !path
  ) {
    return null
  }
  const filePath = path.split('/').map(encodeURIComponent).join('/')
  const route =
    remoteParts.provider === 'gitlab' || remoteParts.provider === 'git'
      ? `/-/blob/${encodeURIComponent(revision)}/${filePath}`
      : `/blob/${encodeURIComponent(revision)}/${filePath}`
  return { provider: remoteParts.provider, url: `${remoteParts.webOrigin}/${repository}${route}` }
}

export async function getFileGitHostedTarget(path: string): Promise<GitHostedFileTarget | null> {
  const git = async (...args: string[]) =>
    (await execFileAsync('git', ['-C', dirname(path), ...args], { timeout: 5_000 })).stdout.trim()
  try {
    const root = await git('rev-parse', '--show-toplevel')
    const file = relative(root, path)
    if (!file || isAbsolute(file) || file === '..' || file.startsWith(`..${sep}`)) return null
    await git('ls-files', '--error-unmatch', '--', `:(literal)${basename(path)}`)
    const remote = await git('remote', 'get-url', 'origin')
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
    const revision = branch === 'HEAD' ? await git('rev-parse', 'HEAD') : branch
    return gitHostedFileTarget(remote, revision, file.split(sep).join('/'))
  } catch {
    return null
  }
}

export function registerWorkspaceFileActions(
  router: HostCapabilityRouter,
  getWindow: () => BrowserWindow
): void {
  const filePath = async (params: Record<string, unknown>) => {
    const path = params.path
    if (typeof path !== 'string' || !isAbsolute(path) || !(await stat(path)).isFile()) {
      throw new Error('Expected an absolute regular file path')
    }
    return path
  }
  router.register('workspace.fileGitHubUrl', async params =>
    getFileGitHostedTarget(await filePath(params))
  )
  router.register('workspace.copyFileContents', async params => {
    const content = await readFile(await filePath(params), 'utf8')
    clipboard.writeText(content)
  })
  router.register('workspace.saveFileAs', async params => {
    const path = await filePath(params)
    const result = await dialog.showSaveDialog(getWindow(), { defaultPath: basename(path) })
    if (result.canceled || !result.filePath) return
    await copyFile(path, result.filePath)
  })
}
