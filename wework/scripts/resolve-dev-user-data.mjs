import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveDevUserDataDirectory(
  projectDirectory,
  configuredDirectory = '',
  homeDirectory = homedir()
) {
  const configured = configuredDirectory.trim()
  if (configured) return resolve(configured)

  const worktreeId = createHash('sha256')
    .update(resolve(projectDirectory))
    .digest('hex')
    .slice(0, 16)

  return join(homeDirectory, 'Library', 'Application Support', 'io.wecode.wework.dev', worktreeId)
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
