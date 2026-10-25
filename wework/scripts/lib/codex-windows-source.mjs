import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { acquireProcessLock } from './process-lock.mjs'

export const CODEX_SOURCE_COMMIT = 'cf4041fa09238f33cf106e3046801ed23590bae8'
const brokerSource = fileURLToPath(
  new URL('../../third_party/codex/windows-read-broker.rs', import.meta.url)
)
const upstreamFsHash = '87c12b3f2baff4e9a12e8654c575c5ac5dea533ae44c21431757bb403b271bac'

export function patchWindowsReadBroker(source) {
  if (createHash('sha256').update(source).digest('hex') !== upstreamFsHash) {
    throw new Error('Pinned Codex filesystem source does not match the reviewed version')
  }
  if (source.split('        let command = self.sandbox_command(sandbox)?;').length !== 2) {
    throw new Error('Codex filesystem broker entry point is ambiguous')
  }
  return source
    .replace(
      'const FS_HELPER_ENV_ALLOWLIST:',
      '#[cfg(windows)]\n#[path = "windows_read_broker.rs"]\nmod windows_read_broker;\n\nconst FS_HELPER_ENV_ALLOWLIST:'
    )
    .replace(
      '        let command = self.sandbox_command(sandbox)?;',
      `        #[cfg(windows)]
        if sandbox.windows_sandbox_selection == codex_file_system::WindowsSandboxSelection::Mxc
            && !codex_sandboxing::windows_mxc_available()
            && windows_read_broker::supports(&request)
        {
            return windows_read_broker::run(sandbox, request).await;
        }
        let command = self.sandbox_command(sandbox)?;`
    )
}

function run(program, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'inherit'],
      shell: false,
    })
    let tail = ''
    child.stdout.on('data', bytes => {
      process.stdout.write(bytes)
      tail = `${tail}${bytes}`.slice(-8192)
    })
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? resolve(tail) : reject(new Error(`${program} exited ${code}`))
    )
  })
}

export async function windowsCodexRecipe() {
  const broker = await readFile(brokerSource)
  const recipe = await readFile(fileURLToPath(import.meta.url))
  return createHash('sha256')
    .update(CODEX_SOURCE_COMMIT)
    .update(broker)
    .update(recipe)
    .digest('hex')
}

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function verifyBundle(root, key) {
  const expected = JSON.parse(await readFile(join(root, 'verified.json'), 'utf8'))
  if (
    expected.recipe !== key ||
    expected.sourceCommit !== CODEX_SOURCE_COMMIT ||
    (await hashFile(join(root, 'codex.exe'))) !== expected.sha256 ||
    (await hashFile(join(root, 'permissions.exe'))) !== expected.testSha256
  ) {
    throw new Error('Windows Codex build integrity mismatch')
  }
  return expected
}

async function testBroker(root) {
  const tests = await run(
    join(root, 'permissions.exe'),
    ['windows_read_broker', '--test-threads=1'],
    root
  )
  if (!/test result: ok\. 5 passed; 0 failed;/.test(tests)) {
    throw new Error('Windows Codex permission broker requires all five native regression tests')
  }
}

export async function transferWindowsCodex(mode, cacheRoot, bundle) {
  const key = await windowsCodexRecipe()
  const root = join(cacheRoot, 'windows-source', key)
  const [source, destination] = mode === 'stage' ? [root, bundle] : [bundle, root]
  if (!['stage', 'restore'].includes(mode))
    throw new Error('Unknown Windows Codex artifact operation')
  await verifyBundle(source, key)
  await mkdir(destination, { recursive: true })
  for (const file of ['codex.exe', 'permissions.exe', 'verified.json']) {
    await cp(join(source, file), join(destination, file))
  }
}

export async function buildWindowsCodex(cacheRoot) {
  const key = await windowsCodexRecipe()
  const root = join(cacheRoot, 'windows-source', key)
  const binary = join(root, 'codex.exe')
  await mkdir(root, { recursive: true })
  const release = await acquireProcessLock(join(root, '.build.lock'))
  try {
    const ready = await readFile(join(root, 'verified.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (ready) {
      const expected = await verifyBundle(root, key)
      await testBroker(root)
      return { binary, sourceCommit: CODEX_SOURCE_COMMIT, recipe: key, sha256: expected.sha256 }
    }
    const source = join(tmpdir(), 'wegent-codex-source', key)
    await rm(source, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    await run('git', ['init', source], root)
    await run('git', ['remote', 'add', 'origin', 'https://github.com/openai/codex.git'], source)
    await run('git', ['fetch', '--depth=1', 'origin', CODEX_SOURCE_COMMIT], source)
    await run('git', ['checkout', '--detach', CODEX_SOURCE_COMMIT], source)
    const fsSource = join(source, 'codex-rs/exec-server/src/fs_sandbox.rs')
    await writeFile(fsSource, patchWindowsReadBroker(await readFile(fsSource, 'utf8')))
    await cp(brokerSource, join(dirname(fsSource), 'windows_read_broker.rs'))
    const target = join(tmpdir(), 'wegent-codex-source-target')
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_BUILD_JOBS: '2',
      CARGO_PROFILE_DEV_DEBUG: '0',
      CARGO_PROFILE_TEST_DEBUG: '0',
      CARGO_PROFILE_RELEASE_LTO: 'false',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    }
    const rust = join(source, 'codex-rs')
    // Keep the upstream lockfile and protocol version. Only the trusted file
    // reader changes; command execution keeps native sandbox enforcement.
    const artifacts = await run(
      'cargo',
      [
        'test',
        '--locked',
        '--release',
        '-p',
        'codex-exec-server',
        '--lib',
        '--no-run',
        '--message-format=json',
      ],
      rust,
      env
    )
    const testBinary = artifacts
      .split('\n')
      .flatMap(line => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      .find(
        artifact =>
          artifact.reason === 'compiler-artifact' &&
          artifact.target.name === 'codex_exec_server' &&
          artifact.profile.test &&
          artifact.executable
      )?.executable
    if (!testBinary) throw new Error('Missing native Codex permission test binary')
    await cp(testBinary, join(root, 'permissions.exe'))
    await testBroker(root)
    await run(
      'cargo',
      ['build', '--locked', '--release', '-p', 'codex-cli', '--bin', 'codex'],
      rust,
      env
    )
    await cp(join(target, 'release/codex.exe'), `${binary}.partial`)
    await rename(`${binary}.partial`, binary)
    const sha256 = await hashFile(binary)
    const testSha256 = await hashFile(join(root, 'permissions.exe'))
    await writeFile(
      join(root, 'verified.json'),
      `${JSON.stringify({ recipe: key, sourceCommit: CODEX_SOURCE_COMMIT, sha256, testSha256 })}\n`
    )
    return { binary, sourceCommit: CODEX_SOURCE_COMMIT, recipe: key, sha256 }
  } finally {
    await release()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  transferWindowsCodex(process.argv[2], process.argv[3], process.argv[4]).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
