import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native'
import { Button, Text, useTheme } from 'react-native-paper'
import { WebView, type WebViewNavigation } from 'react-native-webview'

import { weworkIssueBootstrapUrl, weworkWebOrigin } from '@/domain/weworkIssueLink'

interface WebIssueScreenProps {
  accessToken: string
  projectId: string
  itemId: string
  webUrl: string
}

export function WebIssueScreen({ accessToken, projectId, itemId, webUrl }: WebIssueScreenProps) {
  const theme = useTheme()
  const webViewRef = useRef<WebView>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const uri = useMemo(
    () => weworkIssueBootstrapUrl(webUrl, { projectId, itemId }, accessToken),
    [accessToken, itemId, projectId, webUrl]
  )
  const origin = useMemo(() => weworkWebOrigin(webUrl), [webUrl])
  const shouldStartLoad = useCallback(
    (request: WebViewNavigation) => {
      if (request.url === 'about:blank') return true
      try {
        if (origin && new URL(request.url).origin === origin) return true
      } catch {
        // Non-HTTP schemes are handed to the operating system below.
      }
      void Linking.openURL(request.url).catch(() => undefined)
      return false
    },
    [origin]
  )

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <WebView
        ref={webViewRef}
        source={{ uri }}
        style={styles.webView}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        originWhitelist={origin ? [origin, 'about:blank'] : ['about:blank']}
        onShouldStartLoadWithRequest={shouldStartLoad}
        onLoadStart={() => setLoadFailed(false)}
        onError={() => setLoadFailed(true)}
        onHttpError={() => setLoadFailed(true)}
        onNavigationStateChange={navigation => {
          if (navigation.url.includes('/login')) setLoadFailed(true)
        }}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
          </View>
        )}
        testID="web-issue-view"
      />
      {loadFailed && (
        <View style={[styles.error, { backgroundColor: theme.colors.background }]}>
          <Text style={styles.errorTitle}>Issue 页面加载失败</Text>
          <Text style={styles.errorText}>请确认当前登录态有效，然后重试。</Text>
          <Button
            mode="contained"
            onPress={() => webViewRef.current?.reload()}
            testID="web-issue-retry"
          >
            重试
          </Button>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webView: {
    flex: 1,
  },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  errorText: {
    textAlign: 'center',
    opacity: 0.7,
  },
})
