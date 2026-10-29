import { useCallback, useMemo } from 'react'
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'
import { WebView, type WebViewNavigation } from 'react-native-webview'

import { jwtExpiry } from '@/auth/authClient'
import { weworkIssueWebUrl, weworkWebOrigin } from '@/domain/weworkIssueLink'
import { weworkWebSessionScript } from '@/domain/weworkWebSession'

interface WebIssueScreenProps {
  accessToken: string
  projectId: string
  itemId: string
  webUrl: string
}

export function WebIssueScreen({ accessToken, projectId, itemId, webUrl }: WebIssueScreenProps) {
  const theme = useTheme()
  const uri = useMemo(
    () => weworkIssueWebUrl(webUrl, { projectId, itemId }),
    [itemId, projectId, webUrl]
  )
  const origin = useMemo(() => weworkWebOrigin(webUrl), [webUrl])
  const sessionScript = useMemo(
    () => weworkWebSessionScript(accessToken, jwtExpiry(accessToken)),
    [accessToken]
  )
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
        source={{ uri }}
        style={styles.webView}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        injectedJavaScriptBeforeContentLoaded={sessionScript}
        originWhitelist={origin ? [origin, 'about:blank'] : ['about:blank']}
        onShouldStartLoadWithRequest={shouldStartLoad}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
          </View>
        )}
        testID="web-issue-view"
      />
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
})
