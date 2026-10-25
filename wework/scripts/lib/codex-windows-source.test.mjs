import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  CODEX_SOURCE_COMMIT,
  configurePinnedSourceCheckout,
  patchWindowsReadBroker,
  patchWindowsNoFollow,
  transferWindowsCodex,
  windowsCodexRecipe,
} from './codex-windows-source.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-windows-source-'))
  roots.push(root)
  const recipe = await windowsCodexRecipe()
  const cache = join(root, 'cache')
  const built = join(cache, 'windows-source', recipe)
  await mkdir(built, { recursive: true })
  const binary = Buffer.from('built runtime fixture')
  const tests = Buffer.from('native test binary fixture')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(built, 'codex.exe'), binary)
  await writeFile(join(built, 'permissions.exe'), tests)
  await writeFile(
    join(built, 'verified.json'),
    JSON.stringify({
      recipe,
      sourceCommit: CODEX_SOURCE_COMMIT,
      sha256: hash(binary),
      testSha256: hash(tests),
    })
  )
  return { root, built, cache, recipe, binary, tests, bundle: join(root, 'bundle') }
}

test('rejects unreviewed upstream source before applying a compatibility patch', () => {
  expect(() => patchWindowsReadBroker('let command = self.sandbox_command(sandbox)?;')).toThrow(
    'does not match the reviewed version'
  )
})

test.each(['mod.rs', 'windows.rs'])('rejects changed upstream no-follow source: %s', kind => {
  expect(() => patchWindowsNoFollow('unreviewed filesystem implementation', kind)).toThrow(
    'does not match the reviewed version'
  )
})

test('pinned checkout overrides CRLF conversion and enables complete Windows paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-checkout-'))
  roots.push(root)
  const git = args =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git(['init'])
  git(['config', '--local', 'core.autocrlf', 'true'])
  const canonical = 'fn main() {\n    println!("fixture");\n}\n'
  const file = join(root, 'fixture.rs')
  await writeFile(file, canonical)
  git(['add', 'fixture.rs'])
  await rm(file)
  git(['checkout-index', '--all', '--force'])
  expect(await readFile(file, 'utf8')).toBe(canonical.replaceAll('\n', '\r\n'))
  await configurePinnedSourceCheckout(root)
  await rm(file)
  git(['checkout-index', '--all', '--force'])
  expect(await readFile(file, 'utf8')).toBe(canonical)
  expect(git(['config', '--get', 'core.longpaths'])).toBe('true')
})

test('same-run artifact preserves both executable identities and the pinned recipe', async () => {
  const item = await fixture()
  await transferWindowsCodex('stage', item.cache, item.bundle)
  const restored = join(item.root, 'restored')
  await transferWindowsCodex('restore', restored, item.bundle)
  const build = join(restored, 'windows-source', item.recipe)
  expect(await readFile(join(build, 'codex.exe'))).toEqual(item.binary)
  expect(await readFile(join(build, 'permissions.exe'))).toEqual(item.tests)
})

test.each(['codex.exe', 'permissions.exe'])(
  'rejects a modified %s before restoring artifacts',
  async file => {
    const item = await fixture()
    await transferWindowsCodex('stage', item.cache, item.bundle)
    await writeFile(join(item.bundle, file), 'modified executable')
    const restored = join(item.root, 'restored')
    await expect(transferWindowsCodex('restore', restored, item.bundle)).rejects.toThrow(
      'integrity mismatch'
    )
    await expect(
      readFile(join(restored, 'windows-source', item.recipe, 'verified.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

test('rejects artifacts from a different source version or build recipe', async () => {
  const item = await fixture()
  const metadata = JSON.parse(await readFile(join(item.built, 'verified.json'), 'utf8'))
  metadata.sourceCommit = 'different commit'
  await writeFile(join(item.built, 'verified.json'), JSON.stringify(metadata))
  await expect(transferWindowsCodex('stage', item.cache, item.bundle)).rejects.toThrow(
    'integrity mismatch'
  )
})
