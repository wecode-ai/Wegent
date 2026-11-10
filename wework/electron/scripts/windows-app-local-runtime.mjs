import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const VC_RUNTIME = /^(?:vcruntime|msvcp|concrt)\d+(?:_[a-z0-9_]+)?\.dll$/i

// Read normal and delay imports without executing an unprepared Windows binary.
export function windowsDllImports(buffer) {
  const pe = buffer.readUInt32LE(0x3c)
  if (buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0' || buffer.readUInt16LE(pe + 4) !== 0x8664)
    throw new Error('App-local VC runtime deployment requires an x64 PE binary')
  const optional = pe + 24
  if (buffer.readUInt16LE(optional) !== 0x20b) throw new Error('Expected PE32+ binary')
  const sections = optional + buffer.readUInt16LE(pe + 20)
  const offset = rva => {
    for (let index = 0; index < buffer.readUInt16LE(pe + 6); index += 1) {
      const section = sections + index * 40
      const start = buffer.readUInt32LE(section + 12)
      const size = Math.max(buffer.readUInt32LE(section + 8), buffer.readUInt32LE(section + 16))
      if (rva >= start && rva < start + size) return buffer.readUInt32LE(section + 20) + rva - start
    }
    throw new Error(`Invalid PE RVA: ${rva}`)
  }
  const imports = new Set()
  for (const [directory, stride, nameOffset] of [
    [1, 20, 12],
    [13, 32, 4],
  ]) {
    const rva = buffer.readUInt32LE(optional + 112 + directory * 8)
    const size = buffer.readUInt32LE(optional + 116 + directory * 8)
    if (!rva) continue
    for (let entry = offset(rva), end = entry + size; entry + stride <= end; entry += stride) {
      const nameRva = buffer.readUInt32LE(entry + nameOffset)
      if (!nameRva) break
      if (directory === 13 && !(buffer.readUInt32LE(entry) & 1))
        throw new Error('Unsupported VA-based delay import')
      const start = offset(nameRva)
      const end = buffer.indexOf(0, start)
      if (end < 0) throw new Error('Unterminated PE DLL import')
      imports.add(buffer.toString('ascii', start, end).toLowerCase())
    }
  }
  return [...imports]
}

export async function findWindowsCrtDirectory(environment = process.env) {
  // An explicit directory also supports cross-packaging with an approved toolchain.
  if (environment.WEWORK_VC_REDIST_DIR?.trim()) return environment.WEWORK_VC_REDIST_DIR.trim()
  let redist = environment.VCToolsRedistDir?.trim()
  if (!redist) {
    const programFiles = environment['ProgramFiles(x86)']
    if (!programFiles) throw new Error('Visual C++ redistributable directory is unavailable')
    const { stdout } = await execute(
      join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { windowsHide: true }
    )
    if (!stdout.trim()) throw new Error('Visual Studio C++ build tools are unavailable')
    const root = join(stdout.trim(), 'VC', 'Redist', 'MSVC')
    const versions = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (!versions.length) throw new Error(`No Visual C++ redistributables under ${root}`)
    redist = join(root, versions[0])
  }
  const architecture = join(redist, 'x64')
  const directories = (await readdir(architecture)).filter(name =>
    /^Microsoft\.VC\d+\.CRT$/.test(name)
  )
  if (directories.length !== 1)
    throw new Error(`Expected one x64 CRT directory under ${architecture}`)
  return join(architecture, directories[0])
}

/** Deploy only the VC dependency closure, beside each consuming executable. */
export async function deployWindowsAppLocalRuntime({ resources, executables, crtDirectory }) {
  const available = new Map((await readdir(crtDirectory)).map(name => [name.toLowerCase(), name]))
  const files = new Map()
  for (const executable of executables) {
    const pending = windowsDllImports(await readFile(executable)).filter(name =>
      VC_RUNTIME.test(name)
    )
    const visited = new Set()
    while (pending.length) {
      const name = pending.shift()
      if (visited.has(name)) continue
      visited.add(name)
      const sourceName = available.get(name)
      if (!sourceName)
        throw new Error(`Required Visual C++ runtime ${name} is missing from ${crtDirectory}`)
      const source = join(crtDirectory, sourceName)
      const bytes = await readFile(source)
      pending.push(...windowsDllImports(bytes).filter(dependency => VC_RUNTIME.test(dependency)))
      const destination = join(dirname(executable), name)
      await copyFile(source, destination)
      files.set(destination, {
        path: relative(resources, destination).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}
