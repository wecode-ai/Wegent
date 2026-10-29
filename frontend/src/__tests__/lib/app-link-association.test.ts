import {
  androidAssetLinks,
  appleAppSiteAssociation,
  normalizeAndroidSha256,
  WEWORK_ANDROID_PACKAGE,
} from '@/lib/app-link-association'

const SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
const SHA256_COLONS =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'

describe('App Link associations', () => {
  it('normalizes configured Android signing fingerprints', () => {
    expect(normalizeAndroidSha256(SHA256)).toBe(SHA256_COLONS)
    expect(normalizeAndroidSha256(SHA256_COLONS.toLowerCase())).toBe(SHA256_COLONS)
    expect(normalizeAndroidSha256('not-a-fingerprint')).toBeNull()
  })

  it('publishes every valid Android App Link certificate once', () => {
    expect(androidAssetLinks(`${SHA256}, ${SHA256_COLONS}, invalid`)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: WEWORK_ANDROID_PACKAGE,
          sha256_cert_fingerprints: [SHA256_COLONS],
        },
      },
    ])
    expect(androidAssetLinks(undefined)).toEqual([])
  })

  it('publishes the iOS App Link path for Wework Mobile', () => {
    expect(appleAppSiteAssociation()).toEqual({
      applinks: {
        details: [
          {
            appID: '27XH7KRW54.io.wecode.wework',
            paths: ['/open-wework'],
          },
        ],
      },
    })
  })
})
