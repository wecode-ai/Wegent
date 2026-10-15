import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { dependenciesAreCurrent } from './prepare-dev-dependencies.mjs'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'prepare-dev-dependencies.mjs')
const fixtureRoots = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function dependencyFixture(linkTarget = 'current') {
  const root = await mkdtemp(join(tmpdir(), 'wework-dev-dependency-links-'))
  fixtureRoots.push(root)
  const packageRoot = join(root, 'current', 'packages', 'collaboration')
  const foreignPackageRoot = join(root, 'other', 'packages', 'collaboration')
  const moduleRoot = join(root, 'current', 'wework', 'node_modules')
  await Promise.all(
    [packageRoot, foreignPackageRoot, join(moduleRoot, '@wegent')].map(path =>
      mkdir(path, { recursive: true })
    )
  )
  const link = join(moduleRoot, '@wegent', 'collaboration')
  const target =
    linkTarget === 'current'
      ? packageRoot
      : linkTarget === 'foreign'
        ? foreignPackageRoot
        : join(root, 'missing')
  await symlink(target, link, 'junction')
  const required = join(moduleRoot, 'vite')
  const stampPath = join(moduleRoot, 'dependencies.json')
  await writeFile(required, '')
  await writeFile(stampPath, JSON.stringify({ fingerprint: 'current-fingerprint' }))
  return {
    stampPath,
    required,
    workspaceLinks: [{ link, target: packageRoot }],
  }
}

describe('prepare-dev-dependencies', () => {
  test('preserves the caller environment and fingerprints preparation logic', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).not.toContain("CI: process.env.CI || '1'")
    expect(source.match(/join\(scriptDirectory, 'prepare-dev-dependencies\.mjs'\)/g)).toHaveLength(
      2
    )
  })

  test('routes Windows scripts through the shared command wrapper', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain(
      "import { wrapWindowsScriptCommand } from './child-process-command.mjs'"
    )
    expect(source).toContain('const resolved = wrapWindowsScriptCommand(command, args)')
    expect(source).toContain('spawn(resolved.command, resolved.args, {')
  })

  test.each([
    ['current', true],
    ['foreign', false],
    ['missing', false],
  ])('validates a %s workspace link despite a matching stamp', async (linkTarget, expected) => {
    const fixture = await dependencyFixture(linkTarget)

    expect(
      await dependenciesAreCurrent(
        fixture.stampPath,
        'current-fingerprint',
        [fixture.required],
        fixture.workspaceLinks
      )
    ).toBe(expected)
  })

  test('invalidates dependencies when a required binary disappears', async () => {
    const fixture = await dependencyFixture()
    await rm(fixture.required)

    expect(
      await dependenciesAreCurrent(
        fixture.stampPath,
        'current-fingerprint',
        [fixture.required],
        fixture.workspaceLinks
      )
    ).toBe(false)
  })

  test('invalidates dependencies when the fingerprint changes', async () => {
    const fixture = await dependencyFixture()

    expect(
      await dependenciesAreCurrent(
        fixture.stampPath,
        'changed-fingerprint',
        [fixture.required],
        fixture.workspaceLinks
      )
    ).toBe(false)
  })
})
