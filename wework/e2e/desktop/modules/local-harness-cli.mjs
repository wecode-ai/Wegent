import { execFile } from 'node:child_process'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function createLocalHarnessCliAlias(
  executablePath,
  aliasPath,
  platform = process.platform
) {
  if (platform !== 'win32') {
    await symlink(executablePath, aliasPath)
    return
  }
  // Preserve the npm launcher shape so the executor can unwrap its native target.
  // Chaining another .cmd through CALL rejects multiline agent arguments.
  const directory = `${dirname(executablePath)}\\`
  const launcher = await readFile(executablePath, 'utf8')
  await writeFile(
    aliasPath,
    launcher.replaceAll('%~dp0', directory).replaceAll('%dp0%', directory),
    'utf8'
  )
}

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
