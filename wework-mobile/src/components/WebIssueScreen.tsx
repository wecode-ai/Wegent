import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native'
import { Button, Text, useTheme } from 'react-native-paper'
import { WebView, type WebViewNavigation } from 'react-native-webview'

import {
  weworkIssueBootstrapUrl,
  weworkWebOrigin,
  type WeworkIssueDestination,
} from '@/domain/weworkIssueLink'
import { useWebIssueSession } from '@/hooks/useWebIssueSession'
import type { RuntimeSessionConfig } from '@/services/backendConfig'

interface WebIssueScreenProps {
  config: RuntimeSessionConfig
  issue: WeworkIssueDestination
  userId: number
  onRefreshSession: () => Promise<boolean>
  onReauthorize: () => Promise<void>
}

export function WebIssueScreen({
  config,
  issue,
  userId,
  onRefreshSession,
  onReauthorize,
}: WebIssueScreenProps) {
  const theme = useTheme()
  const webViewRef = useRef<WebView>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [webViewRevision, setWebViewRevision] = useState(0)
  const webUrl = config.webUrl || config.backendUrl
  const uri = useMemo(() => weworkIssueBootstrapUrl(webUrl, issue), [issue, webUrl])
  const deliverGrant = useCallback(
    (script: string) => webViewRef.current?.injectJavaScript(script),
    []
  )
  const session = useWebIssueSession(config, userId, uri, deliverGrant)
  const origin = useMemo(() => weworkWebOrigin(webUrl), [webUrl])
  const retry = useCallback(async () => {
    setRecovering(true)
    try {
      if (session.errorStatus === 401) {
        if (await onRefreshSession()) {
          session.resetSession()
          setLoadFailed(false)
          setWebViewRevision(revision => revision + 1)
        } else {
          await onReauthorize()
        }
        return
      }
      session.resetSession()
      setLoadFailed(false)
      setWebViewRevision(revision => revision + 1)
    } catch {
      setLoadFailed(true)
    } finally {
      setRecovering(false)
    }
  }, [onReauthorize, onRefreshSession, session])
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
        key={webViewRevision}
        ref={webViewRef}
        source={{ uri }}
        style={styles.webView}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        webviewDebuggingEnabled={__DEV__}
        originWhitelist={origin ? [origin, 'about:blank'] : ['about:blank']}
        onShouldStartLoadWithRequest={shouldStartLoad}
        onMessage={event => {
          void session.receiveMessage(event.nativeEvent.data, event.nativeEvent.url)
        }}
        onLoadStart={event => {
          session.startPage(event.nativeEvent.url)
          setLoadFailed(false)
        }}
        onLoadEnd={event => {
          void session.finishPage(event.nativeEvent.url)
        }}
        onError={() => setLoadFailed(true)}
        onHttpError={event => session.reportError(event.nativeEvent.statusCode)}
        onNavigationStateChange={navigation => {
          try {
            if (new URL(navigation.url).pathname === '/login') session.reportError(401)
          } catch {
            // Only HTTP page navigations can indicate an expired Web session.
          }
        }}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading} testID="web-issue-loading">
            <ActivityIndicator color={theme.colors.primary} size="large" />
          </View>
        )}
        testID="web-issue-view"
      />
      {(loadFailed || session.errorStatus !== null) && (
        <View
          style={[styles.error, { backgroundColor: theme.colors.background }]}
          testID={session.errorStatus === 403 ? 'web-issue-forbidden' : 'web-issue-error'}
        >
          <Text style={styles.errorTitle}>
            {session.errorStatus === 403
              ? '没有权限访问此 Issue'
              : session.errorStatus === 409
                ? 'Web 登录账户与 App 不一致'
                : session.errorStatus === 401
                  ? '登录已过期'
                  : 'Issue 页面加载失败'}
          </Text>
          <Text style={styles.errorText}>
            {session.errorStatus === 409
              ? '请先在 Web 中退出其他账户，再重试。当前登录账户已保留。'
              : session.errorStatus === 403
                ? '请向项目成员确认访问权限。'
                : '请确认网络及当前登录态有效，然后重试。'}
          </Text>
          {session.errorStatus !== 403 && (
            <Button
              mode="contained"
              loading={recovering}
              disabled={recovering}
              onPress={() => void retry()}
              testID={session.errorStatus === 401 ? 'web-issue-reauthorize' : 'web-issue-retry'}
            >
              {session.errorStatus === 401 ? '恢复登录' : '重试'}
            </Button>
          )}
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
