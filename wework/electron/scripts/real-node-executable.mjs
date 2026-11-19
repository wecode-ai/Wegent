import { execFile } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Inside the project's own Electron runtime host, 'node' on PATH and the
// ambient process binary are the host's Electron helper (or a shim execing
// it), not Node.js. Fixtures that need a real Node.js child must probe
// candidates and return the executable reported by that child. This resolves
// version-manager shims before later fixtures replace HOME/USERPROFILE. Keep
// the probe environment untouched: stripping ELECTRON_RUN_AS_NODE would boot
// a helper candidate as a full application instead of answering the probe.
const probe = async candidate => {
  const { stdout } = await execute(
    candidate,
    [
      '-p',
      'JSON.stringify([process.versions.electron ?? "", process.versions.node, process.execPath, process.features.typescript ?? ""])',
    ],
    { timeout: 10_000, killSignal: 'SIGKILL' }
  )
  const parsed = JSON.parse(stdout.trim())
  if (!Array.isArray(parsed) || parsed.length !== 4) return null
  const [electronVersion, nodeVersion, executable, typescript] = parsed
  if (
    typeof electronVersion !== 'string' ||
    typeof nodeVersion !== 'string' ||
    typeof executable !== 'string' ||
    typeof typescript !== 'string'
  ) {
    return null
  }
  if (!electronVersion && nodeVersion && executable && typescript) {
    return { executable, nodeVersion }
  }
  return null
}

const candidateNames = () => (process.platform === 'win32' ? ['node.exe'] : ['node'])

const defaultFallbackDirectories = () => {
  if (process.platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  if (process.platform === 'win32') {
    return [process.env.ProgramFiles && resolve(process.env.ProgramFiles, 'nodejs')].filter(Boolean)
  }
  return ['/usr/bin', '/usr/local/bin']
}

export async function resolveRealNodeExecutable({
  pathValue = process.env.PATH,
  fallbackDirectories = defaultFallbackDirectories(),
} = {}) {
  const directories = [
    ...(pathValue ?? '').split(delimiter).filter(Boolean),
    ...fallbackDirectories,
  ]
  for (const directory of directories) {
    for (const name of candidateNames()) {
      const candidate = resolve(directory, name)
      try {
        const resolved = await probe(candidate)
        if (resolved) return resolved
      } catch {
        // Not an executable node here; keep looking.
      }
    }
  }
  throw new Error(
    'A real Node.js executable is required but none was found on PATH or in the well-known install directories: ' +
      directories.join(delimiter)
  )
}
