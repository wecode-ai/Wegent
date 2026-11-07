// @vitest-environment node

import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { createUnownedDshCookieFixtures } from '../../e2e/desktop/modules/smart-app-cookie-lifecycle.mjs'

const name = (port: number) =>
  `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}`

test('excludes a default-session Core on port 55000 and existing browser cookies', () => {
  const coreName = name(55000)
  const browserName = name(55001)
  const fixtures = createUnownedDshCookieFixtures([coreName, browserName])
  const names = fixtures.map((cookie: { name: string }) => cookie.name)

  expect(fixtures).toHaveLength(100)
  expect(new Set(names).size).toBe(100)
  expect(names).not.toContain(coreName)
  expect(names).not.toContain(browserName)
  expect(names[0]).toBe(name(55002))
  expect(
    fixtures
      .map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`)
      .join('; ').length
  ).toBeGreaterThan(16384)
})
