import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { ActivityIndicator, useTheme } from 'react-native-paper'
import type { WebView } from 'react-native-webview'

import {
  isPreviewLinkAllowed,
  parsePreviewEvent,
  type PreviewState,
} from '../../../preview/protocol'
import { openMobilePreview, type MobilePreviewSession } from '@/services/mobilePreviewRuntime'
import type { LoadedMobileFile } from '@/types/files'
import { isMarkdownFile } from '../../../../packages/chat-core/src/workspace-file-types'

interface MobileDocumentPreviewProps {
  document: LoadedMobileFile
  mode: 'preview' | 'source'
  search: string
  wrap: boolean
  initialPosition: number
  onPositionChange: (position: number) => void
  onOpenLink: (href: string) => void
  onError: (message: string) => void
  onResolveResource?: (href: string) => Promise<{ uri: string; name: string; release?: () => void }>
}

export function MobileDocumentPreview(props: MobileDocumentPreviewProps) {
  const theme = useTheme()
  const webview = useRef<WebView>(null)
  const latest = useRef(props)
  latest.current = props
  const sourceContent = props.document.uri ? undefined : props.document.text
  const documentKey = JSON.stringify([props.document.uri, props.document.name, sourceContent])
  const [openedSession, setSession] = useState<
    (MobilePreviewSession & { documentKey: string }) | null
  >(null)
  const session = openedSession?.documentKey === documentKey ? openedSession : null
  const [ready, setReady] = useState(false)
  const [PreviewWebView, setPreviewWebView] = useState<typeof WebView | null>(null)

  useEffect(() => {
    let cancelled = false
    void import('react-native-webview')
      .then(module => {
        if (!cancelled) setPreviewWebView(() => module.WebView)
      })
      .catch(error => {
        if (!cancelled)
          latest.current.onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let opened: MobilePreviewSession | undefined
    setSession(null)
    setReady(false)
    void openMobilePreview(latest.current.document, controller.signal)
      .then(value => {
        opened = value
        if (!controller.signal.aborted) setSession({ ...value, documentKey })
        else
          void value.release().catch(error => console.warn('[FilePreview] Cleanup failed', error))
      })
      .catch(error => {
        if (!controller.signal.aborted)
          latest.current.onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      controller.abort()
      void opened?.release().catch(error => console.warn('[FilePreview] Cleanup failed', error))
    }
  }, [documentKey])

  useEffect(() => {
    if (!session || ready) return
    const timeout = setTimeout(
      () => latest.current.onError('文件预览资源加载超时，请重新打开文件；若仍失败请重新构建应用'),
      20000
    )
    return () => clearTimeout(timeout)
  }, [session, ready])

  useEffect(() => {
    if (!session || !ready) return
    const state: PreviewState = {
      name: props.document.name,
      path: props.document.path,
      mimeType: props.document.mimeType,
      size: props.document.size,
      text: props.document.text,
      kind: props.document.kind,
      truncated: props.document.truncated,
      lineStart: props.document.lineStart,
      lineEnd: props.document.lineEnd,
      url: session.fileUrl,
      mode: props.mode,
      search: props.search,
      wrap: props.wrap,
      initialPosition: props.initialPosition,
      theme: theme.dark ? 'dark' : 'light',
      plantumlServerUrl: process.env.EXPO_PUBLIC_PLANTUML_SERVER_URL?.trim() ?? '',
    }
    const payload = JSON.stringify({ token: session.bridgeToken, state })
    webview.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('wework-preview', { detail: ${payload} })); true;`
    )
  }, [
    props.document,
    props.mode,
    props.search,
    props.wrap,
    props.initialPosition,
    ready,
    session,
    theme.dark,
  ])

  const openLink = (href: string) => {
    if (isPreviewLinkAllowed(href)) latest.current.onOpenLink(href)
  }

  if (!session || !PreviewWebView)
    return <ActivityIndicator style={styles.loading} testID="file-preview-loading" />

  const page = session.url.split('#')[0]
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <PreviewWebView
        ref={webview}
        testID="file-preview-webview"
        source={{ uri: session.url }}
        style={styles.container}
        originWhitelist={['*']}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowsInlineMediaPlayback
        onShouldStartLoadWithRequest={request => {
          if (request.isTopFrame === false) return /^(about:|blob:|https?:)/i.test(request.url)
          if (request.url.split('#')[0] === page) return true
          openLink(request.url)
          return false
        }}
        onOpenWindow={event => openLink(event.nativeEvent.targetUrl)}
        onMessage={event => {
          const message = parsePreviewEvent(event.nativeEvent.data, session.bridgeToken)
          if (!message) return
          if (message.type === 'ready') setReady(true)
          else if (message.type === 'position') latest.current.onPositionChange(message.value)
          else if (message.type === 'link') openLink(message.href)
          else if (message.type === 'resource') {
            if (
              latest.current.mode !== 'preview' ||
              latest.current.document.kind !== 'text' ||
              !isMarkdownFile(latest.current.document.name)
            )
              return
            const resolve = latest.current.onResolveResource
            const send = (result: { url?: string; error?: string }) => {
              const payload = JSON.stringify({
                token: session.bridgeToken,
                id: message.id,
                ...result,
              })
              webview.current?.injectJavaScript(
                `window.dispatchEvent(new CustomEvent('wework-preview-resource', { detail: ${payload} })); true;`
              )
            }
            if (!resolve) {
              send({ error: '此文件没有可用的资源来源' })
              return
            }
            void resolve(message.href)
              .then(async resource => {
                try {
                  return await session.addResource(resource)
                } finally {
                  resource.release?.()
                }
              })
              .then(url => send({ url }))
              .catch(error =>
                send({ error: error instanceof Error ? error.message : String(error) })
              )
          } else latest.current.onError(message.message)
        }}
        onError={event => latest.current.onError(event.nativeEvent.description)}
        onHttpError={event => {
          if (event.nativeEvent.url.split('#')[0] === page)
            latest.current.onError(
              `文件预览加载失败 (HTTP ${event.nativeEvent.statusCode})，请重新打开文件`
            )
        }}
        onContentProcessDidTerminate={() =>
          latest.current.onError('文件预览已被系统关闭，请重新打开')
        }
        onRenderProcessGone={() => latest.current.onError('文件预览已被系统关闭，请重新打开')}
      />
      {!ready ? <ActivityIndicator style={styles.overlay} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1 },
  overlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
})
