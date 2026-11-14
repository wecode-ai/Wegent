import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  resolveWorkspaceFilePath,
  workspaceParentPath,
} from '../../../../packages/chat-core/src/workspace-file-paths'
import { isHtmlFile, isMarkdownFile } from '../../../../packages/chat-core/src/workspace-file-types'
import { canPreviewSource, canSearchPreview } from '../../../preview/protocol'
import {
  formatFileSize,
  mobileAttachmentRequest,
  mobileFileKey,
  mobileFileName,
  resolveMobileFileLink,
} from '@/domain/mobileFiles'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { MobileFileStore } from '@/services/mobileFileStore'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { LoadedMobileFile, MobileFileRequest, RecentMobileFile } from '@/types/files'
import { FileDirectoryBrowser } from './FileDirectoryBrowser'
import { MobileDocumentPreview } from './MobileDocumentPreview'

export type FileLocation =
  | { kind: 'directory'; target: MobileWorkspaceFileTarget }
  | { kind: 'file'; request: MobileFileRequest }

interface FileBrowserModalProps {
  api: RuntimeApi
  apiBaseUrl: string
  store: MobileFileStore
  location: FileLocation
  recent: RecentMobileFile[]
  onClose: () => void
  onBack: () => void
  onNavigate: (location: FileLocation) => void
  onLoaded: (request: MobileFileRequest, document: LoadedMobileFile) => void
  onPositionChange: (request: MobileFileRequest, position: number) => void
  onLink: (href: string, target: MobileWorkspaceFileTarget | null) => void
}

export function FileBrowserModal(props: FileBrowserModalProps) {
  const theme = useTheme()
  const { location } = props
  return (
    <Modal
      visible
      presentationStyle="fullScreen"
      animationType="slide"
      onRequestClose={props.onBack}
    >
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <FileAction
            label="返回"
            icon="chevron-back"
            testID="file-preview-back"
            onPress={props.onBack}
          />
          <Text style={styles.title} numberOfLines={1} variant="titleMedium">
            {location.kind === 'directory'
              ? '文件'
              : (props.recent.find(item => item.key === mobileFileKey(location.request))?.name ??
                mobileFileName(location.request))}
          </Text>
          <FileAction
            label="关闭文件预览"
            icon="close"
            testID="file-preview-close"
            onPress={props.onClose}
          />
        </View>
        {location.kind === 'directory' ? (
          <FileDirectoryBrowser
            key={`${location.target.deviceId}:${location.target.path}`}
            api={props.api}
            target={location.target}
            recent={props.recent}
            onNavigate={props.onNavigate}
            onPath={path => props.onLink(path, location.target)}
          />
        ) : (
          <FilePreviewContent
            key={`${mobileFileKey(location.request)}:${location.request.kind === 'workspace' ? (location.request.lineStart ?? '') : ''}`}
            {...props}
            request={location.request}
          />
        )}
      </SafeAreaView>
    </Modal>
  )
}

function FilePreviewContent({
  request,
  store,
  apiBaseUrl,
  recent,
  onLoaded,
  onPositionChange,
  onLink,
  onNavigate,
}: FileBrowserModalProps & { request: MobileFileRequest }) {
  const theme = useTheme()
  const [document, setDocument] = useState<LoadedMobileFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rendererError, setRendererError] = useState<string | null>(null)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [revision, setRevision] = useState(0)
  const [mode, setMode] = useState<'preview' | 'source'>(
    request.kind === 'workspace' && request.lineStart ? 'source' : 'preview'
  )
  const [search, setSearch] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [lineDraft, setLineDraft] = useState('')
  const initialPosition = useRef(
    recent.find(item => item.key === mobileFileKey(request))?.position ?? 0
  )
  const sharingAbort = useRef<AbortController | null>(null)
  const resourcesAbort = useRef(new AbortController())
  useEffect(() => () => sharingAbort.current?.abort(), [])
  useEffect(() => () => resourcesAbort.current.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    let lease: Awaited<ReturnType<MobileFileStore['acquire']>> | undefined
    setLoading(true)
    setError(null)
    setRendererError(null)
    setDocument(null)
    void store
      .acquire(request, {
        signal: controller.signal,
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      })
      .then(
        acquired => {
          lease = acquired
          const value = acquired.document
          if (!controller.signal.aborted) {
            setDocument(value)
            onLoaded(request, value)
          } else acquired.release()
        },
        cause => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause))
        }
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      lease?.release()
    }
  }, [store, request, revision, onLoaded])

  const refresh = () => {
    store.invalidate(request)
    setRevision(value => value + 1)
  }
  const share = async () => {
    const controller = new AbortController()
    let lease: Awaited<ReturnType<MobileFileStore['acquire']>> | undefined
    sharingAbort.current = controller
    setSharing(true)
    try {
      const Sharing = await import('expo-sharing')
      if (!(await Sharing.isAvailableAsync())) throw new Error('此设备暂不支持系统文件分享')
      lease = await store.acquire(request, { signal: controller.signal, complete: true })
      const complete = lease.document
      if (!controller.signal.aborted)
        await Sharing.shareAsync(complete.uri, {
          mimeType: complete.mimeType,
          dialogTitle: complete.name,
        })
    } catch (cause) {
      if (!controller.signal.aborted)
        Alert.alert('无法分享文件', cause instanceof Error ? cause.message : String(cause))
    } finally {
      lease?.release()
      if (!controller.signal.aborted) setSharing(false)
    }
  }
  const attachmentReference =
    request.kind === 'attachment' ? request.attachment.workspace_file : undefined
  const attachmentPath =
    attachmentReference &&
    resolveWorkspaceFilePath({ path: attachmentReference.workspace_path }, attachmentReference.path)
  const owner =
    request.kind === 'workspace'
      ? { ...request.target, path: workspaceParentPath(request.path) }
      : attachmentReference && attachmentPath
        ? { deviceId: attachmentReference.device_id, path: workspaceParentPath(attachmentPath) }
        : null
  const openDiffSource = () => {
    if (request.kind !== 'diff' || !request.path) return
    const target = { deviceId: request.summary.device_id, path: request.summary.workspace_path }
    const path = resolveWorkspaceFilePath(target, request.path)
    if (!path) {
      Alert.alert('无法打开文件', '文件路径无效')
      return
    }
    onNavigate({ kind: 'file', request: { kind: 'workspace', target, path } })
  }
  const canRender =
    document &&
    (document.kind !== 'text' || isMarkdownFile(document.name) || isHtmlFile(document.name))
  const changeMode = (value: 'preview' | 'source') => {
    setRendererError(null)
    setMode(value)
  }
  const copyPath = () => {
    if (document)
      void Clipboard.setStringAsync(document.path).catch(cause =>
        Alert.alert('复制失败', String(cause))
      )
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height" automaticOffset>
      <View style={styles.toolbar}>
        <Text
          numberOfLines={1}
          style={[styles.path, { color: theme.colors.onSurfaceVariant }]}
          variant="bodySmall"
        >
          {document
            ? `${document.path} · ${formatFileSize(document.size)}`
            : mobileFileName(request)}
        </Text>
        <FileAction
          label="复制文件路径"
          icon="copy-outline"
          testID="file-preview-copy-path"
          disabled={!document}
          onPress={copyPath}
        />
        <FileAction
          label="刷新文件"
          icon="refresh"
          testID="file-preview-refresh"
          disabled={loading}
          onPress={refresh}
        />
        <FileAction
          label="分享或存储文件"
          icon="share-outline"
          testID="file-preview-share"
          disabled={!document || sharing}
          onPress={() => {
            void share()
          }}
        />
      </View>
      {sharing ? <ActivityIndicator size="small" testID="file-sharing" /> : null}
      {document?.truncated ? (
        <Text style={styles.notice} testID="file-truncated-notice">
          预览显示文件的前 256 KB。分享或存储会读取完整文件。
        </Text>
      ) : null}
      {document ? (
        <View style={styles.toolbar}>
          {canRender ? (
            <>
              <TextAction
                label="预览"
                testID="file-mode-preview"
                selected={mode === 'preview'}
                onPress={() => changeMode('preview')}
              />
              {canPreviewSource(document) ? (
                <TextAction
                  label="源码"
                  testID="file-mode-source"
                  selected={mode === 'source'}
                  onPress={() => changeMode('source')}
                />
              ) : null}
            </>
          ) : null}
          {canSearchPreview(document, mode) ? (
            <TextAction
              label="查找"
              testID="file-find"
              selected={searchVisible}
              onPress={() => {
                setSearchVisible(value => !value)
                setSearch('')
              }}
            />
          ) : null}
          {canPreviewSource(document) ? (
            <TextAction
              label="换行"
              testID="file-wrap"
              selected={wrap}
              onPress={() => setWrap(value => !value)}
            />
          ) : null}
          {request.kind === 'diff' && request.path ? (
            <TextAction label="当前文件" testID="file-diff-open-source" onPress={openDiffSource} />
          ) : null}
        </View>
      ) : null}
      {searchVisible ? (
        <View style={styles.toolbar}>
          <TextInput
            testID="file-find-input"
            accessibilityLabel="查找文件内容"
            value={search}
            onChangeText={setSearch}
            autoFocus
            style={[
              styles.input,
              styles.path,
              { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
            ]}
            placeholder="查找内容"
            placeholderTextColor={theme.colors.onSurfaceVariant}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {canPreviewSource(document!) ? (
            <>
              <TextInput
                testID="file-line-input"
                accessibilityLabel="跳转行号"
                value={lineDraft}
                onChangeText={setLineDraft}
                keyboardType="number-pad"
                placeholder="行号"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                style={[
                  styles.input,
                  {
                    width: 68,
                    color: theme.colors.onSurface,
                    backgroundColor: theme.colors.surfaceVariant,
                  },
                ]}
              />
              <TextAction
                label="跳转"
                testID="file-line-go"
                onPress={() => {
                  const lineStart = Number(lineDraft)
                  if (!Number.isSafeInteger(lineStart) || lineStart <= 0) {
                    Alert.alert('请输入有效行号')
                    return
                  }
                  changeMode('source')
                  setDocument(value =>
                    value ? { ...value, lineStart, lineEnd: undefined } : value
                  )
                }}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text>
            {progress.total
              ? `正在读取 ${formatFileSize(progress.loaded)} / ${formatFileSize(progress.total)}`
              : '正在读取文件…'}
          </Text>
        </View>
      ) : null}
      {error || rendererError ? (
        <View style={styles.center} testID="file-preview-error">
          <Text style={{ color: theme.colors.error }}>{error || rendererError}</Text>
          <TextAction label="重试" testID="file-preview-retry" onPress={refresh} />
        </View>
      ) : null}
      {document && !rendererError ? (
        <MobileDocumentPreview
          document={document}
          mode={mode}
          search={search}
          wrap={wrap}
          initialPosition={initialPosition.current}
          onPositionChange={value => onPositionChange(request, value)}
          onOpenLink={href => onLink(href, owner)}
          onResolveResource={async href => {
            const attachment = mobileAttachmentRequest(href, apiBaseUrl)
            const resolved = attachment
              ? { kind: 'file', request: attachment }
              : resolveMobileFileLink(href, owner)
            if (resolved.kind !== 'file' || !('request' in resolved))
              throw new Error('无法定位图片所属的设备文件')
            const lease = await store.acquire(resolved.request, {
              signal: resourcesAbort.current.signal,
              complete: true,
            })
            return { uri: lease.document.uri, name: lease.document.name, release: lease.release }
          }}
          onError={setRendererError}
        />
      ) : null}
    </KeyboardAvoidingView>
  )
}

export function FileAction({
  label,
  icon,
  testID,
  disabled,
  onPress,
}: {
  label: string
  icon: React.ComponentProps<typeof Ionicons>['name']
  testID: string
  disabled?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[styles.action, disabled && { opacity: 0.35 }]}
    >
      <Ionicons name={icon} size={22} color={theme.colors.onSurface} />
    </Pressable>
  )
}

function TextAction({
  label,
  testID,
  selected,
  onPress,
}: {
  label: ReactNode
  testID: string
  selected?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.action,
        styles.textAction,
        selected && { backgroundColor: theme.colors.surfaceVariant },
      ]}
    >
      <Text>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  title: { flex: 1, textAlign: 'center' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 4,
    flexWrap: 'wrap',
  },
  path: { flex: 1 },
  action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  textAction: { paddingHorizontal: 12, borderRadius: 8 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  notice: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
  input: { minHeight: 44, borderRadius: 8, paddingHorizontal: 10, fontSize: 15 },
})
