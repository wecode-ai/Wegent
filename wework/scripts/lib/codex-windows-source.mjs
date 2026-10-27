import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { acquireProcessLock } from './process-lock.mjs'
import { isolatedGitEnvironment } from './git-environment.mjs'

export const CODEX_SOURCE_COMMIT = 'cf4041fa09238f33cf106e3046801ed23590bae8'
export const CODEX_SOURCE_VERSION = '0.163.0-alpha.5'
const NATIVE_TARGET = 'x86_64-pc-windows-msvc'
const PROFILE_OPT_LEVELS = { release: '3', ci: '0' }
const brokerSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../third_party/codex/windows-read-broker.rs'
)
const upstreamFsHash = '87c12b3f2baff4e9a12e8654c575c5ac5dea533ae44c21431757bb403b271bac'

export function verifyWorkspaceVersionRefresh(original, refreshed) {
  const before = original.split('[[package]]\n')
  const after = refreshed.split('[[package]]\n')
  if (before.length !== after.length) throw new Error('Codex dependency graph changed')
  let changes = 0
  for (let index = 0; index < before.length; index++) {
    if (before[index] === after[index]) continue
    const normalized = after[index].replace(
      `version = "${CODEX_SOURCE_VERSION}"\n`,
      'version = "0.0.0"\n'
    )
    if (
      /^source = /m.test(before[index]) ||
      !/^version = "0\.0\.0"$/m.test(before[index]) ||
      normalized !== before[index]
    ) {
      throw new Error('Codex dependency graph changed beyond workspace release versions')
    }
    changes++
  }
  return changes
}

export function patchWindowsNoFollow(source, kind) {
  const hashes = {
    'mod.rs': '5f252ef0d4c82cc7ed1a25c1491a7427a474a2b8828442bca71e636ed747729b',
    'windows.rs': '521b6d515e4c60c922f615077ffadde90200723fb1793c16c3d02691d5221af7',
  }
  if (createHash('sha256').update(source).digest('hex') !== hashes[kind]) {
    throw new Error('Pinned Codex no-follow source does not match the reviewed version')
  }
  if (kind === 'windows.rs') return source.replace('fn open_entry(', 'pub(super) fn open_entry(')
  return `${source}\n#[cfg(windows)]\npub(crate) fn open_metadata_file(path: &Path) -> io::Result<std::fs::File> {\n    imp::open_entry(path)\n}\n`
}

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
      env: program === 'git' ? isolatedGitEnvironment(env) : env,
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

export async function configurePinnedSourceCheckout(source, environment = process.env) {
  for (const [key, value] of [
    ['core.longpaths', 'true'],
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
  ]) {
    await run('git', ['config', '--local', key, value], source, environment)
  }
}

function windowsCodexProfile(value = process.env.WEWORK_CODEX_PROFILE) {
  const profile = value?.trim() || 'release'
  if (Object.hasOwn(PROFILE_OPT_LEVELS, profile)) return profile
  throw new Error(`Unsupported Windows Codex profile: ${profile}`)
}

export function verifyWindowsCodexCompilerProfile(actual, profile) {
  if (
    actual.opt_level !== PROFILE_OPT_LEVELS[windowsCodexProfile(profile)] ||
    actual.debug_assertions !== false ||
    actual.overflow_checks !== false
  ) {
    throw new Error('Windows Codex compilation profile mismatch')
  }
}

function compilerArtifact(output, name, test) {
  const artifact = output
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
        artifact.target.name === name &&
        artifact.profile.test === test &&
        artifact.executable
    )
  if (!artifact) throw new Error(`Missing native Codex compiler artifact: ${name}`)
  return artifact
}

export async function windowsCodexRecipe(profile) {
  const buildProfile = windowsCodexProfile(profile)
  const broker = await readFile(brokerSource)
  const recipe = await readFile(fileURLToPath(import.meta.url))
  const gitEnvironment = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'git-environment.mjs')
  )
  return createHash('sha256')
    .update(CODEX_SOURCE_COMMIT)
    .update(buildProfile)
    .update(broker)
    .update(recipe)
    .update(gitEnvironment)
    .digest('hex')
}

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function verifyWindowsCodexBundle(root, key) {
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
  if (!/test result: ok\. 5 passed; 0 failed; 0 ignored;/.test(tests)) {
    throw new Error('Windows Codex permission broker requires all five native regression tests')
  }
}

export async function buildWindowsCodex(cacheRoot) {
  const profile = windowsCodexProfile()
  const key = await windowsCodexRecipe(profile)
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
      const expected = await verifyWindowsCodexBundle(root, key)
      await testBroker(root)
      return { binary, sourceCommit: CODEX_SOURCE_COMMIT, recipe: key, sha256: expected.sha256 }
    }
    const source = join(tmpdir(), 'wegent-codex-source', key)
    await rm(source, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    await run('git', ['init', source], root)
    await configurePinnedSourceCheckout(source)
    await run('git', ['remote', 'add', 'origin', 'https://github.com/openai/codex.git'], source)
    await run('git', ['fetch', '--depth=1', 'origin', CODEX_SOURCE_COMMIT], source)
    await run('git', ['checkout', '--detach', CODEX_SOURCE_COMMIT], source)
    await run('git', ['diff', '--exit-code', '--quiet'], source)
    const fsSource = join(source, 'codex-rs/exec-server/src/fs_sandbox.rs')
    await writeFile(fsSource, patchWindowsReadBroker(await readFile(fsSource, 'utf8')))
    await cp(brokerSource, join(dirname(fsSource), 'windows_read_broker.rs'))
    for (const kind of ['mod.rs', 'windows.rs']) {
      const path = join(dirname(fsSource), 'no_follow', kind)
      await writeFile(path, patchWindowsNoFollow(await readFile(path, 'utf8'), kind))
    }
    const target = join(tmpdir(), 'wegent-codex-source-target')
    const env = {
      ...isolatedGitEnvironment(),
      CARGO_TARGET_DIR: target,
      CARGO_BUILD_JOBS: '2',
      CARGO_PROFILE_RELEASE_DEBUG: '0',
      CARGO_PROFILE_RELEASE_OPT_LEVEL: PROFILE_OPT_LEVELS[profile],
      // Preserve release-only security guards in the unoptimized CI build.
      CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS: 'false',
      CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS: 'false',
      CARGO_PROFILE_RELEASE_LTO: 'false',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    }
    const rust = join(source, 'codex-rs')
    // Upstream release tags stamp Cargo.toml but retain 0.0.0 in Cargo.lock.
    // Follow upstream's workspace-only refresh, then reject any other change.
    const lockPath = join(rust, 'Cargo.lock')
    const originalLock = await readFile(lockPath, 'utf8')
    await run('cargo', ['update', '--workspace'], rust, env)
    const refreshed = verifyWorkspaceVersionRefresh(originalLock, await readFile(lockPath, 'utf8'))
    console.log(`Verified ${refreshed} workspace release versions; external dependencies unchanged`)
    // Keep the upstream lockfile and protocol version. Only the trusted file
    // reader changes; command execution keeps native sandbox enforcement.
    const artifacts = await run(
      'cargo',
      [
        'test',
        '--locked',
        '--release',
        '--target',
        NATIVE_TARGET,
        '-p',
        'codex-exec-server',
        '--lib',
        '--no-run',
        '--message-format=json',
      ],
      rust,
      env
    )
    const testArtifact = compilerArtifact(artifacts, 'codex_exec_server', true)
    verifyWindowsCodexCompilerProfile(testArtifact.profile, profile)
    await cp(testArtifact.executable, join(root, 'permissions.exe'))
    await testBroker(root)
    const cliArtifacts = await run(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '--target',
        NATIVE_TARGET,
        '-p',
        'codex-cli',
        '--bin',
        'codex',
        '--message-format=json',
      ],
      rust,
      env
    )
    verifyWindowsCodexCompilerProfile(
      compilerArtifact(cliArtifacts, 'codex', false).profile,
      profile
    )
    await cp(join(target, NATIVE_TARGET, 'release/codex.exe'), `${binary}.partial`)
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
