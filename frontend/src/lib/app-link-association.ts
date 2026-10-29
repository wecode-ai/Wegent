const SHA256_FINGERPRINT = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i
const HEX_SHA256 = /^[0-9a-f]{64}$/i

export const WEWORK_ANDROID_PACKAGE = 'com.wecode.wegent'
export const WEWORK_IOS_TEAM_ID = '27XH7KRW54'
export const WEWORK_IOS_BUNDLE_ID = 'io.wecode.wework'
export const WEWORK_APP_LINK_PATH = '/open-wework'

export interface AndroidAssetLink {
  relation: string[]
  target: {
    namespace: 'android_app'
    package_name: string
    sha256_cert_fingerprints: string[]
  }
}

export interface AppleAppSiteAssociation {
  applinks: {
    details: Array<{
      appID: string
      paths: string[]
    }>
  }
}

export function normalizeAndroidSha256(value: string): string | null {
  const candidate = value.trim()
  if (SHA256_FINGERPRINT.test(candidate)) return candidate.toUpperCase()
  if (!HEX_SHA256.test(candidate)) return null
  return candidate.toUpperCase().match(/.{2}/g)!.join(':')
}

export function androidAssetLinks(
  fingerprints: string | undefined,
  packageName = WEWORK_ANDROID_PACKAGE
): AndroidAssetLink[] {
  const values = (fingerprints ?? '')
    .split(/[\s,]+/)
    .map(normalizeAndroidSha256)
    .filter((value): value is string => value !== null)
  if (values.length === 0) return []

  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [...new Set(values)],
      },
    },
  ]
}

export function appleAppSiteAssociation(
  teamId = WEWORK_IOS_TEAM_ID,
  bundleId = WEWORK_IOS_BUNDLE_ID
): AppleAppSiteAssociation {
  return {
    applinks: {
      details: [
        {
          appID: `${teamId}.${bundleId}`,
          paths: [WEWORK_APP_LINK_PATH],
        },
      ],
    },
  }
}
