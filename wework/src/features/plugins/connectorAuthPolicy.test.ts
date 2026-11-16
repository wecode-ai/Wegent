import { describe, expect, test } from 'vitest'
import type { InstalledPluginComponents } from '@/types/api'
import { requiresInstallConnectorAuth } from './connectorAuthPolicy'

type Connector = NonNullable<InstalledPluginComponents['connectors']>[number]

const accountAuth = {
  protocolVersion: 1 as const,
  credentialType: 'bearer' as const,
  adapter: 'scripts/account-auth.py',
}

const localAuth = {
  kind: 'browser_oauth' as const,
  health: ['scripts/local-auth.sh', 'health'],
  start: ['scripts/local-auth.sh', 'login'],
}

describe('install connector authorization', () => {
  test('includes the local login of a combined snapshot connector', () => {
    expect(
      requiresInstallConnectorAuth({
        slug: 'dingtalk-access',
        authPolicy: 'on_install',
        localAuth,
        accountAuth,
      })
    ).toBe(true)
  })

  test('leaves account-only connections in the account panel', () => {
    expect(
      requiresInstallConnectorAuth({ slug: 'cloud-account', authPolicy: 'on_install', accountAuth })
    ).toBe(false)
  })

  test.each(['oauth2', 'password'] as const)(
    'preserves the existing install flow for managed %s accounts with local login',
    credentialType => {
      expect(
        requiresInstallConnectorAuth({
          slug: 'managed-account',
          authPolicy: 'on_install',
          localAuth,
          accountAuth: { ...accountAuth, credentialType },
        })
      ).toBe(false)
    }
  )

  test('preserves install authorization for existing local and catalog connectors', () => {
    const connectors: Connector[] = [
      { slug: 'local-login', authPolicy: 'on_install', localAuth },
      { slug: 'catalog-oauth', authPolicy: 'on_install' },
    ]
    expect(connectors.map(requiresInstallConnectorAuth)).toEqual([true, true])
  })

  test.each(['optional', 'on_use'] as const)(
    'does not force %s login during install',
    authPolicy => {
      expect(
        requiresInstallConnectorAuth({ slug: 'account', authPolicy, localAuth, accountAuth })
      ).toBe(false)
    }
  )
})
