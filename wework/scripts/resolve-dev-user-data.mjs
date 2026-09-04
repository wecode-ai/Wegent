import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveDevUserDataDirectory(
  projectDirectory,
  configuredDirectory = '',
  homeDirectory = homedir(),
  platform = process.platform,
  environment = process.env
) {
  const configured = configuredDirectory.trim()
  if (configured) return resolve(configured)

  const worktreeId = createHash('sha256')
    .update(resolve(projectDirectory))
    .digest('hex')
    .slice(0, 16)

  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim() || join(homeDirectory, 'AppData', 'Roaming')
    return join(appData, 'io.wecode.wework.dev', worktreeId)
  }
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'io.wecode.wework.dev', worktreeId)
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config')
  return join(configHome, 'io.wecode.wework.dev', worktreeId)
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

  process.stdout.write(resolveDevUserDataDirectory(projectDirectory, process.argv[3] ?? ''))
}
