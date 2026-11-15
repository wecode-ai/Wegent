#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const OPENSSL_VERSION = '3.5.9'
const OPENSSL_SHA256 = '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a'
const TARGET = 'aarch64-unknown-linux-musl'
const EXPECTED_TOOLS = { rustc: '1.94.1', zig: '0.15.2', 'cargo-zigbuild': '0.23.0' }
const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}
const repoInput = option('--repo')
const outputInput = option('--output') ?? process.env.WEWORK_NATIVE_RUNTIME_CACHE
if (!repoInput || !outputInput) {
  throw new Error(
    'Usage: node wework-mobile/scripts/build-local-executor.mjs --repo <Wegent checkout> --output <external build cache>'
  )
}
const repo = path.resolve(repoInput)
const output = path.resolve(outputInput)
const jobs = Number(option('--jobs') ?? '4')
if (!Number.isInteger(jobs) || jobs < 1) throw new Error('--jobs must be a positive integer')
if (!existsSync(path.join(repo, 'executor/Cargo.lock'))) throw new Error('Invalid Wegent checkout')
mkdirSync(output, { recursive: true })
const buildEnv = { ...process.env, RUSTC_WRAPPER: '' }
for (const name of ['OPENSSL_DIR', 'OPENSSL_LIB_DIR', 'OPENSSL_INCLUDE_DIR', 'OPENSSL_STATIC']) {
  delete buildEnv[name]
}
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: repo,
    env: buildEnv,
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`)
  return result.stdout?.trim() ?? ''
}
for (const [tool, version] of Object.entries(EXPECTED_TOOLS)) {
  const actual = run(tool, [tool === 'zig' ? 'version' : '--version'])
  if (!actual.split(/\s+/).includes(version)) {
    throw new Error(`Expected ${tool} ${version}; found ${actual}`)
  }
}
if (!run('rustup', ['target', 'list', '--installed']).split('\n').includes(TARGET)) {
  throw new Error(`Install the matching Rust target first: rustup target add ${TARGET}`)
}
const archive = option('--openssl-archive')
  ? path.resolve(option('--openssl-archive'))
  : path.join(output, `openssl-${OPENSSL_VERSION}.tar.gz`)
const sha256 = filename => createHash('sha256').update(readFileSync(filename)).digest('hex')
if (!existsSync(archive)) {
  const partial = `${archive}.part`
  run('curl', [
    '--fail',
    '--location',
    '--proto',
    '=https',
    '--tlsv1.2',
    '--output',
    partial,
    `https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz`,
  ])
  if (sha256(partial) !== OPENSSL_SHA256) throw new Error('Downloaded OpenSSL checksum mismatch')
  renameSync(partial, archive)
}
if (sha256(archive) !== OPENSSL_SHA256) throw new Error('OpenSSL checksum mismatch')
const source = path.join(output, `openssl-${OPENSSL_VERSION}`)
const prefix = path.join(output, 'openssl')
if (!existsSync(source)) run('tar', ['-xzf', archive, '-C', output])
function logged(command, argv, name, options = {}) {
  const filename = path.join(output, name)
  const fd = openSync(filename, 'w')
  try {
    run(command, argv, { ...options, stdio: ['ignore', fd, fd] })
  } catch (error) {
    throw new Error(`${error.message}; see ${filename}`, { cause: error })
  } finally {
    closeSync(fd)
  }
}
console.log('Building pinned static OpenSSL for Linux ARM64 musl')
const sslEnv = {
  ...buildEnv,
  CC: 'zig cc -target aarch64-linux-musl',
  AR: 'zig ar',
  RANLIB: 'zig ranlib',
}
logged(
  './Configure',
  [
    'linux-aarch64',
    'no-shared',
    'no-tests',
    `--prefix=${prefix}`,
    '--openssldir=/etc/ssl',
    '--libdir=lib',
  ],
  'openssl-configure.log',
  { cwd: source, env: sslEnv }
)
logged('make', [`-j${jobs}`, 'build_libs'], 'openssl-build.log', { cwd: source, env: sslEnv })
logged('make', ['install_dev'], 'openssl-install.log', { cwd: source, env: sslEnv })
Object.assign(buildEnv, {
  CARGO_TARGET_DIR: path.join(output, 'target'),
  ZIG_GLOBAL_CACHE_DIR: path.join(output, 'zig-cache'),
  AARCH64_UNKNOWN_LINUX_MUSL_OPENSSL_DIR: prefix,
  AARCH64_UNKNOWN_LINUX_MUSL_OPENSSL_LIB_DIR: path.join(prefix, 'lib'),
  AARCH64_UNKNOWN_LINUX_MUSL_OPENSSL_INCLUDE_DIR: path.join(prefix, 'include'),
  AARCH64_UNKNOWN_LINUX_MUSL_OPENSSL_STATIC: '1',
})
console.log('Building executor with the checked-in Cargo.lock')
logged(
  'cargo',
  [
    'zigbuild',
    '--release',
    '--locked',
    '--target',
    TARGET,
    '--bin',
    'wegent-executor',
    `-j${jobs}`,
  ],
  'cargo-build.log',
  { cwd: path.join(repo, 'executor') }
)
const binary = path.join(output, 'wegent-executor')
const stagedBinary = `${binary}.building`
writeFileSync(
  stagedBinary,
  readFileSync(path.join(output, 'target', TARGET, 'release/wegent-executor')),
  { mode: 0o755 }
)
run(process.env.LLVM_STRIP ?? 'llvm-strip', ['--strip-all', stagedBinary])
const elf = readFileSync(stagedBinary)
if (
  !elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
  elf[4] !== 2 ||
  elf[5] !== 1 ||
  elf.readUInt16LE(18) !== 183
) {
  throw new Error('Expected a little-endian AArch64 ELF64 binary')
}
const programOffset = Number(elf.readBigUInt64LE(32))
for (let index = 0; index < elf.readUInt16LE(56); index++) {
  const entry = programOffset + index * elf.readUInt16LE(54)
  const type = elf.readUInt32LE(entry)
  if (type === 3) throw new Error('Executor unexpectedly requires a dynamic interpreter')
  if (type !== 2) continue
  const start = Number(elf.readBigUInt64LE(entry + 8))
  const end = start + Number(elf.readBigUInt64LE(entry + 32))
  for (let offset = start; offset < end; offset += 16) {
    if (elf.readBigInt64LE(offset) === 1n)
      throw new Error('Executor unexpectedly requires shared libraries')
  }
}
renameSync(stagedBinary, binary)
const metadata = {
  sourceCommit: run('git', ['rev-parse', 'HEAD']),
  sourceTreeDirty: run('git', ['status', '--porcelain']).length > 0,
  target: TARGET,
  tools: EXPECTED_TOOLS,
  opensslVersion: OPENSSL_VERSION,
  opensslSourceSha256: OPENSSL_SHA256,
  binarySha256: sha256(binary),
  binaryBytes: elf.length,
  staticLinkVerified: true,
}
writeFileSync(path.join(output, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
console.log(JSON.stringify({ binary, ...metadata }, null, 2))
