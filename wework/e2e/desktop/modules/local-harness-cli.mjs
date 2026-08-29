import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function localHarnessCliPath(binDirectory, name, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix
  return path.join(binDirectory, platform === 'win32' ? `${name}.cmd` : name)
}

export async function localHarnessCliVersion(executablePath, platform = process.platform) {
  const { stdout } = await execFileAsync(executablePath, ['--version'], {
    shell: platform === 'win32',
  })
  return stdout.trim().split('\n')[0] ?? ''
}
