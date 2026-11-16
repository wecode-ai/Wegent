import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const VC_RUNTIME = /^(?:vcruntime|msvcp|concrt)\d+(?:_[a-z0-9_]+)?\.dll$/i

/**
 * Add static CRT linking for a Windows Rust target.
 * Encoded flags take precedence over RUSTFLAGS and target-specific flags, so
 * writing the effective flags back as CARGO_ENCODED_RUSTFLAGS cannot be
 * overridden by an existing environment variable.
 */
export function windowsStaticCrtEnvironment(environment, target) {
  if (!target?.includes('windows')) return environment
  const targetKey = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_RUSTFLAGS`
  const encoded = environment.CARGO_ENCODED_RUSTFLAGS
  const effective =
    encoded !== undefined
      ? encoded.split('\x1f')
      : (environment.RUSTFLAGS ?? environment[targetKey] ?? '').split(/\s+/)
  const flags = effective.filter(Boolean)
  flags.push('-C', 'target-feature=+crt-static')
  return { ...environment, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') }
}

/** Read normal and delay imports without executing an unprepared Windows binary. */
export function windowsPeImports(buffer) {
  const pe = buffer.readUInt32LE(0x3c)
  if (buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0' || buffer.readUInt16LE(pe + 4) !== 0x8664)
    throw new Error('Windows native runtime verification requires an x64 PE binary')
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

export async function assertWindowsNativeRuntimeIndependent(root) {
  const violations = []
  for (const executable of await windowsExecutables(root)) {
    const runtimeImports = windowsPeImports(await readFile(executable)).filter(name =>
      VC_RUNTIME.test(name)
    )
    if (runtimeImports.length) {
      violations.push(`${relative(root, executable)} imports ${runtimeImports.join(', ')}`)
    }
  }
  if (violations.length) {
    throw new Error(
      `Windows executables must not depend on the machine-wide VC++ runtime:\n${violations.join(
        '\n'
      )}\nBuild these components with -C target-feature=+crt-static.`
    )
  }
}

async function windowsExecutables(directory) {
  const executables = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) executables.push(...(await windowsExecutables(path)))
    else if (entry.name.toLowerCase().endsWith('.exe')) executables.push(path)
  }
  return executables
}
