import { useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import type { WorkspaceFileEntry } from '../../../../packages/chat-core/src/workspace-files'
import { workspaceParentPath } from '../../../../packages/chat-core/src/workspace-file-paths'
import { formatFileSize } from '@/domain/mobileFiles'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RecentMobileFile } from '@/types/files'
import type { FileLocation } from './FileBrowserModal'

export function FileDirectoryBrowser({
  api,
  target,
  recent,
  onNavigate,
  onPath,
}: {
  api: RuntimeApi
  target: MobileWorkspaceFileTarget
  recent: RecentMobileFile[]
  onNavigate: (location: FileLocation) => void
  onPath: (path: string) => void
}) {
  const theme = useTheme()
  const [query, setQuery] = useState('')
  const search = query.trim()
  const scope = JSON.stringify([target.deviceId, target.path, search])
  const [pathDraft, setPathDraft] = useState(target.path)
  const [tab, setTab] = useState<'files' | 'recent'>('files')
  const [listing, setListing] = useState<{ scope: string; entries: WorkspaceFileEntry[] }>({
    scope,
    entries: [],
  })
  const entries = listing.scope === scope ? listing.entries : []
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const requestId = useRef(0)
  useEffect(() => {
    setQuery('')
    setPathDraft(target.path)
  }, [target.deviceId, target.path])
  useEffect(() => {
    setListing(current => (current.scope === scope ? current : { scope, entries: [] }))
    if (tab !== 'files') return
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    const timer = setTimeout(
      () => {
        const pending = search
          ? api
              .searchWorkspaceEntries(target.deviceId, target.path, search, `mobile-files-${id}`)
              .then(result =>
                result.files.map(file => ({
                  name: file.fileName,
                  path: file.path,
                  isDirectory: file.matchType === 'directory',
                  size: 0,
                }))
              )
          : api.listWorkspaceDirectory(target.deviceId, target.path).then(result => result.entries)
        void pending
          .then(
            items => {
              if (id === requestId.current)
                setListing({
                  scope,
                  entries: [...items].sort(
                    (a, b) =>
                      Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
                  ),
                })
            },
            cause => {
              if (id === requestId.current) {
                setError(cause instanceof Error ? cause.message : String(cause))
              }
            }
          )
          .finally(() => {
            if (id === requestId.current) setLoading(false)
          })
      },
      search ? 250 : 0
    )
    return () => {
      clearTimeout(timer)
      requestId.current += 1
    }
  }, [api, target.deviceId, target.path, search, scope, revision, tab])
  const textStyle = { color: theme.colors.onSurface }
  const inputStyle = [styles.input, textStyle, { backgroundColor: theme.colors.surfaceVariant }]
  const matchingRecent = recent.filter(({ request }) => {
    const deviceId =
      request.kind === 'workspace'
        ? request.target.deviceId
        : request.kind === 'attachment'
          ? request.attachment.workspace_file?.device_id
          : request.kind === 'diff'
            ? request.summary.device_id
            : undefined
    return !deviceId || deviceId === target.deviceId
  })

  return (
    <KeyboardAvoidingView behavior="height" automaticOffset style={styles.body}>
      <View style={styles.pathRow}>
        <Pressable
          accessibilityLabel="上级目录"
          accessibilityRole="button"
          testID="files-parent"
          style={styles.icon}
          onPress={() =>
            onNavigate({
              kind: 'directory',
              target: { ...target, path: workspaceParentPath(target.path) },
            })
          }
        >
          <Ionicons name="arrow-up" size={21} color={theme.colors.onSurface} />
        </Pressable>
        <TextInput
          accessibilityLabel="文件路径"
          testID="files-path"
          style={[inputStyle, styles.grow]}
          value={pathDraft}
          onChangeText={setPathDraft}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={() => onPath(pathDraft)}
        />
        <Pressable
          accessibilityLabel="刷新目录"
          accessibilityRole="button"
          testID="files-refresh"
          style={styles.icon}
          onPress={() => setRevision(value => value + 1)}
        >
          <Ionicons name="refresh" size={21} color={theme.colors.onSurface} />
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(['files', 'recent'] as const).map(value => (
          <Pressable
            key={value}
            testID={`files-tab-${value}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            style={[styles.tab, tab === value && { backgroundColor: theme.colors.surfaceVariant }]}
            onPress={() => setTab(value)}
          >
            <Text>{value === 'files' ? '文件' : '最近'}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'files' ? (
        <>
          <TextInput
            accessibilityLabel="搜索文件"
            testID="files-search"
            style={[inputStyle, styles.search]}
            placeholder="搜索当前目录中的文件"
            placeholderTextColor={theme.colors.onSurfaceVariant}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
          {loading ? <ActivityIndicator size="small" testID="files-loading" /> : null}
          {error ? (
            <View style={styles.status}>
              <Text style={{ color: theme.colors.error }}>{error}</Text>
              <Pressable
                testID="files-retry"
                accessibilityRole="button"
                style={styles.tab}
                onPress={() => setRevision(value => value + 1)}
              >
                <Text>重试</Text>
              </Pressable>
            </View>
          ) : null}
          <FlatList
            data={entries}
            keyExtractor={entry => entry.path}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            testID="file-directory-list"
            ListEmptyComponent={
              !loading && !error ? (
                <Text style={styles.status}>{search ? '没有匹配的文件' : '目录为空'}</Text>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable
                testID={`file-entry-${item.path}`}
                accessibilityRole="button"
                style={styles.row}
                onPress={() =>
                  onNavigate(
                    item.isDirectory
                      ? { kind: 'directory', target: { ...target, path: item.path } }
                      : { kind: 'file', request: { kind: 'workspace', target, path: item.path } }
                  )
                }
              >
                <Ionicons
                  name={item.isDirectory ? 'folder-outline' : 'document-outline'}
                  size={23}
                  color={theme.colors.onSurfaceVariant}
                />
                <View style={styles.grow}>
                  <Text numberOfLines={1}>{item.name}</Text>
                  {search ? (
                    <Text
                      numberOfLines={1}
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      {item.path}
                    </Text>
                  ) : null}
                </View>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {item.isDirectory ? '›' : formatFileSize(item.size)}
                </Text>
              </Pressable>
            )}
          />
        </>
      ) : (
        <FlatList
          data={matchingRecent}
          keyExtractor={item => item.key}
          keyboardShouldPersistTaps="handled"
          testID="recent-file-list"
          ListEmptyComponent={<Text style={styles.status}>还没有打开过文件</Text>}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              testID={`recent-file-${item.key}`}
              accessibilityRole="button"
              onPress={() => onNavigate({ kind: 'file', request: item.request })}
            >
              <Ionicons name="time-outline" color={theme.colors.onSurfaceVariant} size={22} />
              <View style={styles.grow}>
                <Text numberOfLines={1}>{item.name}</Text>
                <Text numberOfLines={1} variant="bodySmall">
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
  grow: { flex: 1 },
  pathRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  input: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  search: { margin: 12 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, paddingVertical: 8 },
  tab: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  status: { padding: 20, alignItems: 'center', gap: 12 },
})
