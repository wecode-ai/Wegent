import { expect, test } from 'vitest'
import { matchesBundledMarketplaceConfig } from '../e2e/desktop/modules/marketplace-config.mjs'

const windowsPath = String.raw`D:\a\Wegent\executor-home\capabilities\bundled-marketplaces\wework-personal`

test.each([`'${windowsPath}'`, JSON.stringify(windowsPath)])(
  'accepts the Windows source encoded as TOML %s',
  source => {
    const config = `[marketplaces.wework-personal]\nsource_type = "local"\nsource = ${source}\n`
    expect(matchesBundledMarketplaceConfig(config, windowsPath)).toBe(true)
    expect(matchesBundledMarketplaceConfig(config, windowsPath + '-wrong')).toBe(false)
  }
)

test('accepts single-quoted TOML values and requires the complete local marketplace', () => {
  const config =
    "[marketplaces.wework-personal]\nsource_type = 'local'\nsource = '/home/user/plugins'\n"
  expect(matchesBundledMarketplaceConfig(config, '/home/user/plugins')).toBe(true)
  expect(matchesBundledMarketplaceConfig(config.replace("'local'", "'remote'"))).toBe(false)
  expect(matchesBundledMarketplaceConfig(config.replace('wework-personal', 'other'))).toBe(false)
  expect(matchesBundledMarketplaceConfig('[marketplaces.wework-personal]')).toBe(false)
})

test('rejects malformed configuration instead of treating it as registered', () => {
  expect(() => matchesBundledMarketplaceConfig('[marketplaces')).toThrow()
})
