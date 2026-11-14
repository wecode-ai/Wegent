import { useEffect, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { workspaceParentPath } from '../../../../packages/chat-core/src/workspace-file-paths'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RecentMobileFile } from '@/types/files'
import type { WorkspaceGitSelection } from '@/types/workspaceGit'
import { LiquidGlassSurface } from '../LiquidGlass'
import type { FileLocation } from './FileBrowserModal'
import {
  FileAction,
  FileBrowserHeader,
  FileErrorState,
  FileSegments,
  FileTextAction,
  type FileMenuAction,
} from './FileBrowserChrome'
import { FileChangesView } from './FileChangesView'
import { useWorkspaceFileTree } from './useWorkspaceFileTree'

export function FileDirectoryBrowser({
  api,
  target,
  recent,
  initialTab = 'files',
  initialSelection,
  onNavigate,
  onPath,
  onBack,
  onClose,
}: {
  api: RuntimeApi
  target: MobileWorkspaceFileTarget
  recent: RecentMobileFile[]
  initialTab?: 'files' | 'recent' | 'changes'
  initialSelection?: WorkspaceGitSelection
  onNavigate: (location: FileLocation) => void
  onPath: (path: string) => void
  onBack: () => void
  onClose: () => void
}) {
  const theme = useTheme()
  const [query, setQuery] = useState('')
  const [pathDraft, setPathDraft] = useState(target.path)
  const [pathEditing, setPathEditing] = useState(false)
  const [tab, setTab] = useState(initialTab)
  const [selection, setSelection] = useState<WorkspaceGitSelection>(
    initialSelection ?? { mode: 'unstaged' }
  )
  const tree = useWorkspaceFileTree(api, target, query, tab === 'files')
  useEffect(() => {
    setQuery('')
    setPathDraft(target.path)
    setPathEditing(false)
  }, [target.deviceId, target.path])
  useEffect(() => {
    setTab(initialTab)
    setSelection(initialSelection ?? { mode: 'unstaged' })
  }, [initialTab, initialSelection])
  const matchingRecent = recent.filter(({ request }) => {
    const deviceId =
      request.kind === 'workspace' || request.kind === 'git-diff'
        ? request.target.deviceId
        : request.kind === 'attachment'
          ? request.attachment.workspace_file?.device_id
          : request.kind === 'diff'
            ? request.summary.device_id
            : undefined
    return !deviceId || deviceId === target.deviceId
  })
  const actions: FileMenuAction[] = [
    {
      label: '输入文件路径…',
      icon: 'folder-open-outline',
      testID: 'files-edit-path',
      onPress: () => setPathEditing(value => !value),
    },
    {
      label: '上级目录',
      icon: 'arrow-up',
      testID: 'files-parent',
      onPress: () =>
        onNavigate({
          kind: 'directory',
          target: { ...target, path: workspaceParentPath(target.path) },
        }),
    },
    {
      label: '最近打开',
      icon: 'time-outline',
      testID: 'files-tab-recent',
      onPress: () => setTab('recent'),
    },
    {
      label: '复制目录路径',
      icon: 'copy-outline',
      testID: 'files-copy-path',
      onPress: () => {
        void Clipboard.setStringAsync(target.path).catch(cause =>
          Alert.alert('复制失败', String(cause))
        )
      },
    },
  ]
  if (tab === 'files')
    actions.push({
      label: '刷新目录',
      icon: 'refresh',
      testID: 'files-refresh',
      onPress: tree.refresh,
    })
  if (tab === 'changes')
    return (
      <FileChangesView
        api={api}
        target={target}
        selection={selection}
        onSelectionChange={setSelection}
        onFiles={() => setTab('files')}
        onNavigate={onNavigate}
        onClose={onClose}
      />
    )
  return (
    <KeyboardAvoidingView behavior="height" automaticOffset style={styles.body}>
      <FileBrowserHeader
        title={tab === 'recent' ? '最近打开' : '文件'}
        path={target.path}
        onBack={tab === 'recent' ? onBack : undefined}
        onClose={onClose}
        actions={actions}
      />
      <View style={[styles.tabs, { borderBottomColor: theme.colors.outlineVariant }]}>
        <FileSegments
          value="files"
          onChange={value => setTab(value)}
          items={[
            { value: 'changes', label: '已修改', testID: 'files-tab-changes' },
            { value: 'files', label: '所有文件', testID: 'files-tab-files' },
          ]}
        />
      </View>
      {pathEditing ? (
        <View style={styles.pathRow}>
          <TextInput
            accessibilityLabel="文件路径"
            testID="files-path"
            style={[
              styles.input,
              styles.grow,
              theme.fonts.bodyMedium,
              { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
            ]}
            value={pathDraft}
            onChangeText={setPathDraft}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => onPath(pathDraft)}
          />
          <FileAction
            label="打开文件路径"
            icon="arrow-forward"
            testID="files-path-go"
            onPress={() => onPath(pathDraft)}
          />
        </View>
      ) : null}
      {tab === 'files' ? (
        <>
          {tree.loading ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.onSurfaceVariant}
              testID="files-loading"
            />
          ) : null}
          {tree.error ? (
            <FileErrorState
              title={
                query.trim()
                  ? '暂时无法搜索文件'
                  : tree.entries.length
                    ? '目录暂时无法更新'
                    : '暂时无法读取目录'
              }
              message={tree.error}
              testID="files-error"
              retryTestID="files-retry"
              onRetry={tree.refresh}
              compact
            />
          ) : null}
          <FlatList
            style={styles.body}
            contentContainerStyle={[styles.listContent, !tree.entries.length && styles.emptyList]}
            data={tree.entries}
            keyExtractor={entry => entry.path}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            testID="file-directory-list"
            ListEmptyComponent={
              !tree.loading && !tree.error ? (
                <View style={styles.emptyState}>
                  <Ionicons
                    name={query.trim() ? 'search-outline' : 'folder-open-outline'}
                    size={28}
                    color={theme.colors.onSurfaceVariant}
                  />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    {query.trim() ? '没有匹配的文件' : '目录为空'}
                  </Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <View>
                <Pressable
                  testID={`file-entry-${item.path}`}
                  accessibilityRole="button"
                  accessibilityState={item.isDirectory ? { expanded: item.expanded } : undefined}
                  style={({ pressed }) => [
                    styles.row,
                    { paddingLeft: 16 + item.depth * 20 },
                    pressed && { backgroundColor: theme.colors.surfaceVariant },
                  ]}
                  onPress={() =>
                    item.isDirectory
                      ? tree.toggleFolder(item.path)
                      : onNavigate({
                          kind: 'file',
                          request: { kind: 'workspace', target, path: item.path },
                        })
                  }
                >
                  <View style={styles.chevron}>
                    {item.isDirectory ? (
                      <Ionicons
                        name={item.expanded ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.onSurfaceVariant}
                      />
                    ) : null}
                  </View>
                  <Ionicons
                    name={item.isDirectory ? 'folder-outline' : 'document-outline'}
                    size={20}
                    color={theme.colors.onSurfaceVariant}
                  />
                  <View style={styles.grow}>
                    <Text variant="bodyLarge" numberOfLines={1}>
                      {item.name}
                    </Text>
                    {query.trim() ? (
                      <Text
                        numberOfLines={1}
                        variant="bodySmall"
                        style={{ color: theme.colors.onSurfaceVariant }}
                      >
                        {item.path}
                      </Text>
                    ) : null}
                  </View>
                  {item.loading ? (
                    <ActivityIndicator size="small" testID={`files-loading-${item.path}`} />
                  ) : null}
                </Pressable>
                <View
                  style={[
                    styles.rowDivider,
                    {
                      marginLeft: 52 + item.depth * 20,
                      backgroundColor: theme.colors.outlineVariant,
                    },
                  ]}
                />
                {item.error ? (
                  <View style={styles.childError}>
                    <Text
                      variant="bodySmall"
                      style={[styles.grow, { color: theme.colors.onSurfaceVariant }]}
                    >
                      {item.error}
                    </Text>
                    <FileTextAction
                      label="重试"
                      testID={`files-retry-${item.path}`}
                      onPress={() => tree.retryFolder(item.path)}
                    />
                  </View>
                ) : null}
              </View>
            )}
          />
          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{ backgroundColor: theme.colors.elevation.level2 }}
            style={styles.searchPill}
            testID="files-search-surface"
          >
            <Ionicons name="search-outline" size={20} color={theme.colors.onSurfaceVariant} />
            <TextInput
              accessibilityLabel="搜索文件"
              testID="files-search"
              style={[styles.searchInput, theme.fonts.bodyLarge, { color: theme.colors.onSurface }]}
              placeholder="搜索文件"
              placeholderTextColor={theme.colors.onSurfaceVariant}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </LiquidGlassSurface>
        </>
      ) : (
        <FlatList
          style={styles.body}
          contentContainerStyle={matchingRecent.length ? styles.listContent : styles.emptyList}
          data={matchingRecent}
          keyExtractor={item => item.key}
          keyboardShouldPersistTaps="handled"
          testID="recent-file-list"
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="time-outline" size={28} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                还没有打开过文件
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.recentRow}
              testID={`recent-file-${item.key}`}
              accessibilityRole="button"
              onPress={() => onNavigate({ kind: 'file', request: item.request })}
            >
              <Ionicons name="time-outline" color={theme.colors.onSurfaceVariant} size={20} />
              <View style={styles.grow}>
                <Text variant="bodyMedium" numberOfLines={1}>
                  {item.name}
                </Text>
                <Text
                  numberOfLines={1}
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {item.path}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  tabs: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  input: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12 },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 16,
    paddingVertical: 8,
  },
  chevron: { width: 16, alignItems: 'center' },
  rowDivider: { height: StyleSheet.hairlineWidth },
  childError: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 52,
    paddingRight: 16,
    gap: 8,
  },
  listContent: { paddingBottom: 80 },
  emptyList: { flexGrow: 1 },
  emptyState: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  searchPill: {
    position: 'absolute',
    left: 27,
    right: 27,
    bottom: 0,
    height: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
  },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, paddingVertical: 0 },
  recentRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
})
