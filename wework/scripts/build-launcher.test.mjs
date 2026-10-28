import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { buildLauncher } from '../electron/scripts/build-launcher.mjs'

const execute = promisify(execFile)

async function installedLinker() {
  if (process.platform !== 'win32') {
    const { stdout } = await execute('sh', ['-c', 'command -v cc'])
    return stdout.trim()
  }
  const vswhere = join(
    process.env['ProgramFiles(x86)'],
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  )
  const { stdout } = await execute(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ])
  assert.ok(stdout.trim(), 'Visual Studio C++ tools must be installed')
  const tools = join(stdout.trim(), 'VC', 'Tools', 'MSVC')
  const versions = (await readdir(tools)).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true })
  )
  return join(tools, versions[0], 'bin', 'Hostx64', 'x64', 'link.exe')
}

test('launcher honors the target linker with Git link.exe first on PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework launcher linker '))
  const originalEnv = { ...process.env }
  t.after(async () => {
    process.env = originalEnv
    await rm(root, { recursive: true, force: true })
  })
  const { stdout } = await execute('rustc', ['-vV'])
  const target = /^host: (.+)$/m.exec(stdout)[1]
  const key = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`
  const linker = process.env[key] || (await installedLinker())
  let gitBin = join(root, 'git', 'usr', 'bin')
  if (process.platform === 'win32') {
    const { stdout: gitExecPath } = await execute('git', ['--exec-path'])
    // Keep Git's MSYS runtime DLLs beside its real link.exe.
    gitBin = join(gitExecPath.trim(), '..', '..', '..', 'usr', 'bin')
  } else {
    await mkdir(gitBin, { recursive: true })
    // A native executable reproduces Git link.exe rejecting MSVC linker arguments.
    const source = join(root, 'conflicting-linker.rs')
    const conflictingLinker = join(gitBin, 'link.exe')
    await writeFile(
      source,
      'fn main() { eprintln!("Git link.exe selected"); std::process::exit(71); }'
    )
    await execute('rustc', [source, '-C', `linker=${linker}`, '-o', conflictingLinker])
    await cp(conflictingLinker, join(gitBin, 'cc'))
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')
  process.env[pathKey] =
    `${gitBin}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey]}`
  await assert.rejects(
    execute('link.exe', ['/OUT:launcher.exe']),
    'Git link.exe must reject MSVC arguments'
  )

  // Prove that the explicit configuration is used, even when auto-discovery works.
  process.env[key] = join(root, 'missing linker')
  await assert.rejects(buildLauncher(join(root, 'invalid'), target), /missing linker/)

  process.env[key] = linker
  const output = await buildLauncher(join(root, 'configured'), target)
  // Executing the real launcher validates that compilation produced a usable native binary.
  await assert.rejects(execute(output, []), error => error.code === 1)
})
