import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WebIssueScreen } from './WebIssueScreen'
import type { RuntimeSessionConfig } from '@/services/backendConfig'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({ mounts: 0, openURL: vi.fn() }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: harness.openURL },
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Button: 'Button',
  Text: 'Text',
  useTheme: () => ({ colors: { background: '#fff', primary: '#000' } }),
}))
vi.mock('react-native-webview', async () => {
  const { createElement, forwardRef, useEffect, useImperativeHandle } = await import('react')
  return {
    WebView: forwardRef(function WebView(props: Record<string, unknown>, ref) {
      useEffect(() => {
        harness.mounts += 1
      }, [])
      useImperativeHandle(ref, () => ({ injectJavaScript: vi.fn() }))
      return createElement('div', props)
    }),
  }
})

const config: RuntimeSessionConfig = {
  backendUrl: 'https://api.wegent.example',
  apiBaseUrl: 'https://api.wegent.example/api',
  socketBaseUrl: 'https://api.wegent.example',
  socketPath: '/socket.io',
  webUrl: 'https://wegent.example',
  accessToken: 'private-token',
}
const issue = {
  projectId: '12',
  itemId: 'ISSUE-1',
  commentId: 'comment-1',
  focusRequest: 'mobile-1',
}
let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  harness.mounts = 0
  vi.stubGlobal('__DEV__', true)
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  vi.unstubAllGlobals()
})

async function setup() {
  const onRefreshSession = vi.fn(async () => true)
  const onReauthorize = vi.fn(async () => undefined)
  await act(async () => {
    renderer = create(
      <WebIssueScreen
        config={config}
        issue={issue}
        userId={6177}
        onRefreshSession={onRefreshSession}
        onReauthorize={onReauthorize}
      />
    )
  })
  return {
    view: () => renderer!.root.findByType('div'),
    root: () => renderer!.root,
    onRefreshSession,
    onReauthorize,
  }
}

describe('Issue WebView recovery', () => {
  it('recovers an expired Web session by recreating the bootstrap even when native token is unchanged', async () => {
    const screen = await setup()
    const bootstrap = screen.view().props.source.uri
    expect(bootstrap).not.toContain(config.accessToken)
    expect(new URL(bootstrap).searchParams.get('redirect')).toContain('commentId=comment-1')
    act(() => {
      screen.view().props.onNavigationStateChange({ url: 'https://wegent.example/login' })
    })
    await act(async () => {
      screen.root().findByProps({ testID: 'web-issue-reauthorize' }).props.onPress()
    })
    expect(screen.onRefreshSession).toHaveBeenCalledOnce()
    expect(screen.onReauthorize).not.toHaveBeenCalled()
    expect(harness.mounts).toBe(2)
    expect(screen.view().props.source.uri).toBe(bootstrap)
    expect(screen.root().findAllByProps({ testID: 'web-issue-error' })).toHaveLength(0)
  })

  it('returns to standard native authorization when refresh credentials have expired', async () => {
    const screen = await setup()
    screen.onRefreshSession.mockResolvedValue(false)
    act(() => screen.view().props.onHttpError({ nativeEvent: { statusCode: 401 } }))
    await act(async () => {
      screen.root().findByProps({ testID: 'web-issue-reauthorize' }).props.onPress()
    })
    expect(screen.onReauthorize).toHaveBeenCalledOnce()
  })

  it('keeps a permission denial separate from login recovery', async () => {
    const screen = await setup()
    act(() => screen.view().props.onHttpError({ nativeEvent: { statusCode: 403 } }))
    expect(screen.root().findAllByProps({ testID: 'web-issue-forbidden' })).toHaveLength(1)
    expect(screen.root().findAllByProps({ testID: 'web-issue-reauthorize' })).toHaveLength(0)
    expect(screen.onRefreshSession).not.toHaveBeenCalled()
    expect(screen.onReauthorize).not.toHaveBeenCalled()
  })
})
