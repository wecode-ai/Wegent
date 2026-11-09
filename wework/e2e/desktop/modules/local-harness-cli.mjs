import { execFile } from 'node:child_process'
import { access, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, posix, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function createClaudeCliAlias(binDirectory, resultDir, platform = process.platform) {
  const alias = join(resultDir, platform === 'win32' ? 'local-claude.cmd' : 'local-claude')
  await rm(alias, { force: true })
  if (platform === 'win32') {
    // The executor unwraps native shims; nesting another batch file prevents that.
    const packageRoot = resolve(binDirectory, '../@anthropic-ai/claude-code')
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    const native = resolve(packageRoot, metadata.bin.claude)
    await access(native)
    await writeFile(alias, `@echo off\r\n"${native}" %*\r\n`, 'utf8')
  } else {
    await symlink(localHarnessCliPath(binDirectory, 'claude', platform), alias)
  }
  return alias
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
