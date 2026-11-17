// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAccountAuthFixture } from '../e2e/desktop/modules/plugin-account-auth-fixture.mjs'

test.each([
  { accountConnectorSlugs: undefined, expected: ['mail', 'oauth', 'transfer'] },
  { accountConnectorSlugs: ['mail'], expected: ['mail'] },
])(
  'account fixture bounds row-lock candidates to $expected',
  async ({ accountConnectorSlugs, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-account-auth-fixture-'))
    try {
      const fixtureRoot = join(root, 'plugin')
      await createAccountAuthFixture({
        resultDir: root,
        homePath: join(root, 'home'),
        fixtureRoot,
        slug: 'account-auth-fixture',
        secret: 'synthetic-password',
        oauthSecret: 'synthetic-oauth',
        transferSecret: 'synthetic-transfer',
        accountConnectorSlugs,
      })
      const manifest = JSON.parse(
        await readFile(join(fixtureRoot, '.codex-plugin/plugin.json'), 'utf8')
      )
      expect(
        manifest.connectors
          .filter(connector => connector.accountAuth)
          .map(connector => connector.slug)
      ).toEqual(expected)
      expect(
        manifest.connectors.some(connector => connector.slug === 'mail' && connector.localAuth)
      ).toBe(true)
      expect(
        manifest.connectors.some(connector => connector.localAuth && !connector.accountAuth)
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
