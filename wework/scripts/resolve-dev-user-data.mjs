import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveDevUserDataDirectory(
  projectDirectory,
  configuredDirectory = '',
  homeDirectory = homedir(),
  { platform = process.platform, appDataDirectory = '' } = {}
) {
  const configured = configuredDirectory.trim()
  if (configured) return resolve(configured)

  const worktreeHash = createHash('sha256').update(resolve(projectDirectory)).digest('hex')
  const appData =
    appDataDirectory ||
    (platform === 'win32'
      ? join(homeDirectory, 'AppData', 'Roaming')
      : join(homeDirectory, 'Library', 'Application Support'))
  const root = join(appData, 'io.wecode.wework.dev')
  const legacyDirectory = join(root, worktreeHash.slice(0, 12))
  // Older launchers used this directory, which owns the persisted desktop identity.
  if (existsSync(legacyDirectory)) return legacyDirectory

  return join(root, worktreeHash.slice(0, 16))
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectDirectory = process.argv[2]
  if (!projectDirectory) {
    console.error(
      'Usage: node resolve-dev-user-data.mjs <project-directory> [configured-directory]'
    )
    process.exit(1)
  }

  process.stdout.write(
    resolveDevUserDataDirectory(projectDirectory, process.argv[3] ?? '', homedir(), {
      appDataDirectory: process.platform === 'win32' ? process.env.APPDATA : '',
    })
  )
}
