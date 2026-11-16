import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { buildLauncher } from '../electron/scripts/build-launcher.mjs'

const execute = promisify(execFile)

test('a failed native selection opens its healthy bridge in data-independent recovery mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-launcher-recovery-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const { stdout } = await execute('rustc', ['-vV'])
  const target = /^host: (.+)$/m.exec(stdout)[1]
  const launcher = await buildLauncher(join(root, 'resources'), target)
  const bridgeSource = join(root, 'bridge.rs')
  const bridge = join(root, process.platform === 'win32' ? 'bridge.exe' : 'bridge')
  await writeFile(
    bridgeSource,
    `fn main() {
    assert!(std::env::var("WEWORK_RELEASE_SUPERVISED").is_err());
    let message = std::env::var("WEWORK_STARTUP_RECOVERY").expect("recovery mode");
    std::fs::write(std::env::args().nth(1).unwrap(), message).unwrap();
  }`
  )
  await execute('rustc', ['--edition', '2021', bridgeSource, '-o', bridge])
  const releases = join(root, 'releases')
  await mkdir(releases)
  const result = join(root, 'recovery.txt')
  await execute(launcher, [releases, bridge, result], {
    env: { ...process.env, WEWORK_RELEASE_SUPERVISED: 'failed-target' },
  })
  assert.match(await readFile(result, 'utf8'), /^Wework launcher: /)
})
