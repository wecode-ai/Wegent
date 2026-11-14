import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { Alert, Modal, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { ActivityIndicator, Portal, Text, useTheme } from 'react-native-paper'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import {
  resolveWorkspaceFilePath,
  workspaceParentPath,
} from '../../../../packages/chat-core/src/workspace-file-paths'
import { isPreviewableTextFile } from '../../../../packages/chat-core/src/workspace-file-types'
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
import type { WorkspaceGitSelection } from '@/types/workspaceGit'
import { FileDirectoryBrowser } from './FileDirectoryBrowser'
import { MobileDocumentPreview } from './MobileDocumentPreview'
import {
  FileAction,
  FileBrowserHeader,
  FileErrorState,
  FileGlassAction,
  FilePreviewModes,
  FileTextAction,
  type FileMenuAction,
} from './FileBrowserChrome'

export type FileLocation =
  | { kind: 'directory'; target: MobileWorkspaceFileTarget; tab?: 'files' | 'recent' }
  | { kind: 'changes'; target: MobileWorkspaceFileTarget; selection?: WorkspaceGitSelection }
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
      presentationStyle="pageSheet"
      animationType="slide"
      allowSwipeDismissal
      onRequestClose={Platform.OS === 'ios' ? props.onClose : props.onBack}
    >
      <SafeAreaProvider style={styles.screen}>
        <Portal.Host>
          <SafeAreaView
            testID="file-browser-safe-area"
            edges={
              Platform.OS === 'ios'
                ? ['right', 'bottom', 'left']
                : ['top', 'right', 'bottom', 'left']
            }
            style={[
              styles.screen,
              {
                backgroundColor:
                  location.kind === 'file' && !theme.dark ? '#f8f8f8' : theme.colors.background,
              },
            ]}
          >
            {location.kind !== 'file' ? (
              <FileDirectoryBrowser
                key={`${location.target.deviceId}:${location.target.path}`}
                api={props.api}
                target={location.target}
                initialTab={location.kind === 'changes' ? 'changes' : location.tab}
                initialSelection={location.kind === 'changes' ? location.selection : undefined}
                recent={props.recent}
                onNavigate={props.onNavigate}
                onPath={path => props.onLink(path, location.target)}
                onBack={props.onBack}
                onClose={props.onClose}
              />
            ) : (
              <FilePreviewContent
                key={`${mobileFileKey(location.request)}:${location.request.kind === 'workspace' ? (location.request.lineStart ?? '') : ''}`}
                {...props}
                request={location.request}
              />
            )}
          </SafeAreaView>
        </Portal.Host>
      </SafeAreaProvider>
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
  onBack,
  onClose,
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
  const [wrap, setWrap] = useState(true)
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
  const workspaceTarget =
    request.kind === 'workspace' || request.kind === 'git-diff'
      ? request.target
      : request.kind === 'diff'
        ? { deviceId: request.summary.device_id, path: request.summary.workspace_path }
        : attachmentReference
          ? { deviceId: attachmentReference.device_id, path: attachmentReference.workspace_path }
          : null
  const openDiffSource = () => {
    if (
      (request.kind !== 'diff' && request.kind !== 'git-diff') ||
      !request.path ||
      !workspaceTarget
    )
      return
    const target = workspaceTarget
    const path = resolveWorkspaceFilePath(target, request.path)
    if (!path) {
      Alert.alert('无法打开文件', '文件路径无效')
      return
    }
    onNavigate({ kind: 'file', request: { kind: 'workspace', target, path } })
  }
  const canRender = document && (document.kind !== 'text' || isPreviewableTextFile(document.name))
  const changeMode = (value: 'preview' | 'source') => {
    setRendererError(null)
    setMode(value)
  }
  const displayPath =
    document?.path ||
    (request.kind === 'workspace' || request.kind === 'diff' || request.kind === 'git-diff'
      ? request.path
      : undefined) ||
    mobileFileName(request)
  const sourceAvailable = Boolean(document && canPreviewSource(document))
  const canFind = Boolean(document && !rendererError && canSearchPreview(document, mode))
  const shareAction: FileMenuAction = {
    label: '分享或存储文件',
    icon: 'share-outline',
    testID: 'file-preview-share',
    disabled: !document || sharing,
    onPress: () => {
      void share()
    },
  }
  const menuActions: FileMenuAction[] = [
    {
      label: '复制文件路径',
      icon: 'copy-outline',
      testID: 'file-preview-copy-path',
      onPress: () => {
        void Clipboard.setStringAsync(displayPath).catch(cause =>
          Alert.alert('复制失败', String(cause))
        )
      },
    },
    {
      label: '刷新文件',
      icon: 'refresh',
      testID: 'file-preview-refresh',
      disabled: loading,
      onPress: refresh,
    },
  ]
  if (sourceAvailable && !rendererError)
    menuActions.push({
      label: '自动换行',
      icon: 'return-down-back-outline',
      testID: 'file-wrap',
      selected: wrap,
      onPress: () => {
        changeMode('source')
        setWrap(value => !value)
      },
    })
  if ((request.kind === 'diff' || request.kind === 'git-diff') && request.path)
    menuActions.push({
      label: '打开当前文件',
      icon: 'document-outline',
      testID: 'file-diff-open-source',
      onPress: openDiffSource,
    })
  const toggleFind = () => {
    setSearchVisible(value => !value)
    setSearch('')
  }
  if (canFind)
    menuActions.push({
      label: '查找文件内容',
      icon: 'search-outline',
      testID: 'file-find',
      selected: searchVisible,
      onPress: toggleFind,
    })
  const goToLine = () => {
    const lineStart = Number(lineDraft)
    if (!Number.isSafeInteger(lineStart) || lineStart <= 0) {
      Alert.alert('请输入有效行号')
      return
    }
    changeMode('source')
    setDocument(value => (value ? { ...value, lineStart, lineEnd: undefined } : value))
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height" automaticOffset>
      <FileBrowserHeader
        title={
          document?.name ??
          recent.find(item => item.key === mobileFileKey(request))?.name ??
          mobileFileName(request)
        }
        path={displayPath}
        detail={document ? formatFileSize(document.size) : undefined}
        onBack={onBack}
        onClose={onClose}
        actions={menuActions}
        share={shareAction}
      />
      {canRender && sourceAvailable ? (
        <FilePreviewModes value={mode} onChange={changeMode} />
      ) : null}
      {sharing ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" testID="file-sharing" />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            正在准备分享…
          </Text>
        </View>
      ) : null}
      {document?.truncated ? (
        <Text
          variant="bodySmall"
          style={[styles.notice, { color: theme.colors.onSurfaceVariant }]}
          testID="file-truncated-notice"
        >
          仅预览前 256 KB，分享或存储可获取完整文件。
        </Text>
      ) : null}
      {searchVisible && canFind ? (
        <View style={styles.searchPanel}>
          <View style={styles.searchRow}>
            <TextInput
              testID="file-find-input"
              accessibilityLabel="查找文件内容"
              value={search}
              onChangeText={setSearch}
              autoFocus
              style={[
                styles.input,
                styles.grow,
                theme.fonts.bodyMedium,
                { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
              ]}
              placeholder="查找内容"
              placeholderTextColor={theme.colors.onSurfaceVariant}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            <FileAction
              label="关闭查找"
              icon="close"
              testID="file-find-close"
              onPress={toggleFind}
            />
          </View>
          {sourceAvailable ? (
            <View style={styles.searchRow}>
              <TextInput
                testID="file-line-input"
                accessibilityLabel="跳转行号"
                value={lineDraft}
                onChangeText={setLineDraft}
                keyboardType="number-pad"
                placeholder="跳转到行…"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                style={[
                  styles.input,
                  styles.grow,
                  theme.fonts.bodyMedium,
                  { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
                ]}
                onSubmitEditing={goToLine}
              />
              <FileTextAction label="跳转" testID="file-line-go" onPress={goToLine} />
            </View>
          ) : null}
        </View>
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.onSurfaceVariant} />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {progress.total
              ? '正在读取 ' +
                formatFileSize(progress.loaded) +
                ' / ' +
                formatFileSize(progress.total)
              : '正在读取文件…'}
          </Text>
        </View>
      ) : null}
      {error || rendererError ? (
        <ScrollView style={styles.screen} contentContainerStyle={styles.errorContent}>
          <FileErrorState
            title={error ? '暂时无法读取文件' : '暂时无法显示预览'}
            message={error || rendererError!}
            testID="file-preview-error"
            retryTestID="file-preview-retry"
            onRetry={refresh}
          />
        </ScrollView>
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
      <View pointerEvents="box-none" style={styles.floatingActions}>
        <FileGlassAction
          label="浏览工作区文件"
          icon="folder-outline"
          testID="file-preview-folder"
          large
          disabled={!workspaceTarget}
          onPress={() =>
            workspaceTarget && onNavigate({ kind: 'directory', target: workspaceTarget })
          }
        />
        <FileGlassAction
          label="最近打开的文件"
          icon="time-outline"
          testID="file-preview-history"
          large
          disabled={!workspaceTarget}
          onPress={() =>
            workspaceTarget &&
            onNavigate({ kind: 'directory', target: workspaceTarget, tab: 'recent' })
          }
        />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  floatingActions: {
    position: 'absolute',
    left: 27,
    right: 27,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  searchPanel: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  errorContent: { flexGrow: 1, justifyContent: 'center' },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  input: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12 },
})
