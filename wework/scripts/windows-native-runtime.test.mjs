import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { buildLauncher } from '../electron/scripts/build-launcher.mjs'
import {
  assertWindowsNativeRuntimeIndependent,
  windowsPeImports,
  windowsStaticCrtEnvironment,
} from './lib/windows-native-runtime.mjs'

const execute = promisify(execFile)

function peBinary(imports = [], delayImports = []) {
  const bytes = Buffer.alloc(4096)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(0xf0, 0x94)
  bytes.writeUInt16LE(0x20b, 0x98)
  bytes.writeUInt32LE(0xc00, 0x190)
  bytes.writeUInt32LE(0x1000, 0x194)
  bytes.writeUInt32LE(0xc00, 0x198)
  bytes.writeUInt32LE(0x400, 0x19c)
  for (const [names, directory, stride, table, strings, nameOffset] of [
    [imports, 1, 20, 0x400, 0x600, 12],
    [delayImports, 13, 32, 0x500, 0x800, 4],
  ]) {
    bytes.writeUInt32LE(table + 0xc00, 0x98 + 112 + directory * 8)
    bytes.writeUInt32LE((names.length + 1) * stride, 0x98 + 116 + directory * 8)
    names.forEach((name, index) => {
      const entry = table + index * stride
      if (directory === 13) bytes.writeUInt32LE(1, entry)
      bytes.writeUInt32LE(strings + index * 64 + 0xc00, entry + nameOffset)
      bytes.write(name, strings + index * 64)
    })
  }
  return bytes
}

test('reads normal and delayed x64 imports, including mixed-case runtime names', () => {
  assert.deepEqual(windowsPeImports(peBinary(['KERNEL32.dll'], ['VCRUNTIME140.dll'])), [
    'kernel32.dll',
    'vcruntime140.dll',
  ])
})

test('accepts Windows executables that do not import the VC runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-native-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'independent.exe'), peBinary(['KERNEL32.dll']))
  await assert.doesNotReject(assertWindowsNativeRuntimeIndependent(root))
})

test('rejects every executable that depends on the machine-wide VC runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-native-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'independent.exe'), peBinary(['KERNEL32.dll']))
  await writeFile(
    join(root, 'bin', 'dependent.exe'),
    peBinary(['KERNEL32.dll', 'VCRUNTIME140.dll'], ['MSVCP140.dll'])
  )
  await assert.rejects(assertWindowsNativeRuntimeIndependent(root), error => {
    assert.match(error.message, /bin[/\\]dependent\.exe imports vcruntime140\.dll, msvcp140\.dll/)
    assert.match(error.message, /target-feature=\+crt-static/)
    assert.doesNotMatch(error.message, /independent\.exe/)
    return true
  })
})

test('rejects malformed PE input rather than overlooking a runtime dependency', () => {
  assert.throws(() => windowsPeImports(Buffer.alloc(100)), /x64 PE binary/)
  const bytes = peBinary(['VCRUNTIME140.dll'])
  bytes.writeUInt32LE(0xffffff, 0x40c)
  assert.throws(() => windowsPeImports(bytes), /Invalid PE RVA/)
})

test('adds static CRT linking through encoded flags that existing flags cannot override', () => {
  const target = 'x86_64-pc-windows-msvc'
  const encoded = flags => flags.join('\x1f')
  const environment = { RUSTFLAGS: '-C debuginfo=1', CARGO_TARGET_DIR: 'target' }
  assert.equal(windowsStaticCrtEnvironment(environment, 'aarch64-apple-darwin'), environment)
  assert.equal(
    windowsStaticCrtEnvironment(environment, target).CARGO_ENCODED_RUSTFLAGS,
    encoded(['-C', 'debuginfo=1', '-C', 'target-feature=+crt-static'])
  )
  assert.equal(
    windowsStaticCrtEnvironment(
      {
        CARGO_ENCODED_RUSTFLAGS: encoded(['-C', 'opt-level=2']),
        RUSTFLAGS: '-C debuginfo=1',
      },
      target
    ).CARGO_ENCODED_RUSTFLAGS,
    encoded(['-C', 'opt-level=2', '-C', 'target-feature=+crt-static'])
  )
  assert.equal(
    windowsStaticCrtEnvironment(
      { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C opt-level=2' },
      target
    ).CARGO_ENCODED_RUSTFLAGS,
    encoded(['-C', 'opt-level=2', '-C', 'target-feature=+crt-static'])
  )
})

test(
  'the packaged Windows launcher has no VC runtime imports',
  { skip: process.platform !== 'win32' ? 'Requires the Windows MSVC toolchain' : false },
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'wework-static-crt-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const { stdout } = await execute('rustc', ['-vV'])
    const target = /^host: (.+)$/m.exec(stdout)[1]
    const launcher = await buildLauncher(root, target)
    const imports = windowsPeImports(await readFile(launcher))
    assert.deepEqual(
      imports.filter(name => /^(?:vcruntime|msvcp|concrt)\d+/.test(name)),
      []
    )
  }
)

test(
  'forces static CRT when RUSTFLAGS or encoded flags are already set',
  { skip: process.platform !== 'win32' ? 'Requires the Windows MSVC toolchain' : false },
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'wework-static-crt-probe-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'src'))
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "static-crt-probe"\nversion = "0.1.0"\nedition = "2021"\n'
    )
    await writeFile(join(root, 'src', 'main.rs'), 'fn main() {}\n')
    const { stdout } = await execute('rustc', ['-vV'])
    const target = /^host: (.+)$/m.exec(stdout)[1]
    for (const [index, flags] of [
      { CARGO_ENCODED_RUSTFLAGS: undefined, RUSTFLAGS: '-C debuginfo=1' },
      {
        CARGO_ENCODED_RUSTFLAGS: ['-C', 'debuginfo=1'].join('\x1f'),
        RUSTFLAGS: undefined,
      },
    ].entries()) {
      const targetDirectory = join(root, `target-${index}`)
      await execute('cargo', ['build', '--quiet'], {
        cwd: root,
        env: windowsStaticCrtEnvironment(
          { ...process.env, ...flags, CARGO_TARGET_DIR: targetDirectory },
          target
        ),
      })
      const imports = windowsPeImports(
        await readFile(join(targetDirectory, 'debug', 'static-crt-probe.exe'))
      )
      assert.deepEqual(
        imports.filter(name => /^(?:vcruntime|msvcp|concrt)\d+/.test(name)),
        []
      )
    }
  }
)
