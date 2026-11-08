// @vitest-environment node

import { join, win32 } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'

// Exercise the untransformed function that the native fixture embeds in its script.
const { occupiedPublicationEntry } = createRequire(import.meta.url)(
  '../e2e/desktop/modules/workbench-component-publication.mjs'
)

const root = join(process.cwd(), 'publication-fixture')

test.each([
  [
    'composed core plugins',
    ['data', 'managed-components', 'composed', 'wework-core-plugins'],
    join('wework-app', 'client.js'),
  ],
  ['Core runtime', ['runtimes'], 'runtime.json'],
  ['packaged bundled plugins', ['data', 'managed-components', 'packaged', 'bundledPlugins'], null],
  ['packaged core plugins', ['data', 'managed-components', 'packaged', 'weworkCorePlugins'], null],
  ['other composition', ['data', 'managed-components', 'composed', 'other'], null],
  ['unrelated core plugin directory', ['other', 'wework-core-plugins'], null],
])('injects native occupation only into the intended publication: %s', (_name, parts, expected) => {
  const parent = join(root, ...parts)
  expect(
    occupiedPublicationEntry(root, join(parent, '.content-test'), join(parent, 'fingerprint'))
  ).toBe(expected)
})

test('does not hold ordinary runtime links or publications outside the fixture', () => {
  expect(
    occupiedPublicationEntry(
      root,
      join(root, 'runtimes', 'existing'),
      join(root, 'runtimes', 'fingerprint')
    )
  ).toBeNull()
  const parent = join(root, 'other', 'runtimes')
  expect(
    occupiedPublicationEntry(root, join(parent, '.content-test'), join(parent, 'fingerprint'))
  ).toBeNull()
})

test('the injected matcher accepts Windows namespaced sources without holding packaged archives', () => {
  const match = runInNewContext(`(${occupiedPublicationEntry.toString()})`, {
    basename: win32.basename,
    dirname: win32.dirname,
    join: win32.join,
  })
  const windowsRoot = 'D:\\publication-fixture'
  for (const [parts, expected] of [
    [['data', 'managed-components', 'composed', 'wework-core-plugins'], 'wework-app\\client.js'],
    [['runtimes'], 'runtime.json'],
    [['data', 'managed-components', 'packaged', 'bundledPlugins'], null],
  ]) {
    const parent = win32.join(windowsRoot, ...parts)
    expect(
      match(
        windowsRoot,
        win32.toNamespacedPath(win32.join(parent, '.content-test')),
        win32.join(parent, 'fingerprint')
      )
    ).toBe(expected)
  }
})
