import { execFile } from 'node:child_process'
import { readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

export async function processExecutable(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid release process identity')
  if (process.platform === 'linux') return realpath(await readlink(`/proc/${pid}/exe`))
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
  if (process.platform === 'win32' && (!systemRoot || !isAbsolute(systemRoot)))
    throw new Error('Windows system directory is unavailable')
  const [command, args] =
    process.platform === 'win32'
      ? ([
          join(systemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [System.Diagnostics.Process]::GetProcessById(${pid}).MainModule.FileName`,
          ],
        ] as const)
      : (['/bin/ps', ['-p', String(pid), '-o', 'comm=']] as const)
  const { stdout } = await promisify(execFile)(command, [...args], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  const executable = stdout.trim()
  if (!isAbsolute(executable)) throw new Error('Release process executable is unavailable')
  return realpath(executable)
}

export function releaseParentExecutable(): Promise<string> {
  return processExecutable(process.ppid)
}
