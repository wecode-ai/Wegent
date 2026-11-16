import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (value: unknown) => value },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({ ActivityIndicator: 'ActivityIndicator', useTheme: vi.fn() }))
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }))
vi.mock('@dr.pogodin/react-native-fs', () => {
  throw new Error('Preview filesystem is not linked')
})
vi.mock('@dr.pogodin/react-native-static-server', () => {
  throw new Error('Preview server is not linked')
})
vi.mock('react-native-webview', () => {
  throw new Error('Preview WebView is not linked')
})

describe('optional preview native modules', () => {
  it('does not load native preview capabilities while importing the main application UI', async () => {
    expect(
      (await import('../components/files/MobileDocumentPreview')).MobileDocumentPreview
    ).toBeTypeOf('function')
  })
  it('isolates missing native modules to the requested preview operation', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    await expect(
      openMobilePreview({
        name: 'a.pdf',
        path: '/a.pdf',
        mimeType: 'application/pdf',
        size: 1,
        uri: 'file:///a.pdf',
        kind: 'binary',
      })
    ).rejects.toThrow()
  })
})
