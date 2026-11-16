// @vitest-environment node

import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  configuredMarketplaceSource,
  marketplaceSourcesMatch,
  normalizedMarketplaceSource,
} from '../../e2e/desktop/modules/marketplace-config-evidence.mjs'

const marketplaceConfig = (source: string) => `
[marketplaces.wework-personal]
source_type = 'local'
source = ${source}
`

test.each([
  ["'D:\\a\\Wegent\\wework-personal'", 'D:\\a\\Wegent\\wework-personal'],
  ['"D:\\\\a\\\\Wegent\\\\wework-personal"', 'D:\\a\\Wegent\\wework-personal'],
  ["'D:/a/Wegent/wework-personal/'", 'D:/a/Wegent/wework-personal/'],
  ["'/tmp/wework#personal'", '/tmp/wework#personal'],
])('reads the registered marketplace source from TOML', (encoded, expected) => {
  expect(configuredMarketplaceSource(marketplaceConfig(encoded))).toBe(expected)
})

test('ignores sources from unrelated marketplace sections', () => {
  expect(
    configuredMarketplaceSource(`
[marketplaces.other]
source = '/tmp/other'
[marketplaces.wework-personal]
source = '/tmp/wework-personal'
`)
  ).toBe('/tmp/wework-personal')
})

test('compares marketplace paths using the same normalization as reconciliation', async () => {
  const root = join('/tmp', 'wework-personal')
  await expect(
    marketplaceSourcesMatch(`${root}/.agents/plugins/marketplace.json`, root)
  ).resolves.toBe(true)
  await expect(
    marketplaceSourcesMatch('C:\\a\\Wegent\\marketplace', 'C:/a/Wegent/marketplace/')
  ).resolves.toBe(true)
})

test('rejects a different marketplace source', async () => {
  await expect(
    marketplaceSourcesMatch('/tmp/installed-marketplace', '/tmp/bundled-marketplace')
  ).resolves.toBe(false)
})

test('removes both supported manifest suffixes', () => {
  expect(normalizedMarketplaceSource('/tmp/plugins/.claude-plugin/marketplace.json')).toBe(
    '/tmp/plugins'
  )
})
