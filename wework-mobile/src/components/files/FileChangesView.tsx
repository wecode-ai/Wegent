import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState } from 'react'
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { ActivityIndicator, Menu, Text, useTheme } from 'react-native-paper'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import {
  listMobileWorkspaceBranches,
  loadMobileWorkspaceChanges,
} from '@/services/mobileWorkspaceGit'
import type { RuntimeApi } from '@/services/runtimeApi'
import type {
  MobileWorkspaceChangedFile,
  MobileWorkspaceChanges,
  WorkspaceGitSelection,
} from '@/types/workspaceGit'
import type { FileLocation } from './FileBrowserModal'
import {
  FileBrowserHeader,
  FileErrorState,
  FileSegments,
  FileTextAction,
} from './FileBrowserChrome'

const modeLabels = {
  branch: '分支',
  unstaged: '未暂存',
  staged: '已暂存',
  commit: '最近一次提交',
} as const
const emptyLabels = {
  branch: '没有分支更改',
  unstaged: '没有未暂存的更改',
  staged: '没有已暂存的更改',
  commit: '没有提交更改',
} as const
// Bound native text layout across the whole review. Full diffs remain available on demand.
const INLINE_REVIEW_LINE_BUDGET = 400
const INLINE_FILE_LINE_BUDGET = 120

export function FileChangesView({
  api,
  target,
  selection,
  onSelectionChange,
  onFiles,
  onNavigate,
  onClose,
}: {
  api: RuntimeApi
  target: MobileWorkspaceFileTarget
  selection: WorkspaceGitSelection
  onSelectionChange: (selection: WorkspaceGitSelection) => void
  onFiles: () => void
  onNavigate: (location: FileLocation) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const [result, setResult] = useState<{ scope: string; value: MobileWorkspaceChanges } | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const scope = JSON.stringify([target.deviceId, target.path, selection.mode, selection.baseRef])
  const changes = result?.scope === scope ? result.value : null
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setResult(null)
    void loadMobileWorkspaceChanges(api, target, selection, controller.signal)
      .then(
        value => {
          if (!controller.signal.aborted) setResult({ scope, value })
        },
        cause => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause))
        }
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [api, target, selection, scope, revision])
  const deferInline = Boolean(
    changes &&
    changes.files.reduce((total, file) => total + file.lines.length, 0) > INLINE_REVIEW_LINE_BUDGET
  )
  const refresh = () => setRevision(value => value + 1)
  const openFile = (file: MobileWorkspaceChangedFile) =>
    onNavigate({ kind: 'file', request: { kind: 'git-diff', target, selection, path: file.path } })
  return (
    <View style={styles.screen}>
      <FileBrowserHeader
        title={target.path.split(/[\\/]/).filter(Boolean).at(-1) || '更改'}
        path={target.path}
        onClose={onClose}
        subtitle={
          <View style={styles.subtitle}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {modeLabels[selection.mode]}
            </Text>
            {changes && changes.fileCount ? (
              <DiffCounts additions={changes.additions} deletions={changes.deletions} />
            ) : null}
          </View>
        }
        actions={[
          ...(['branch', 'unstaged', 'staged', 'commit'] as const).map(mode => ({
            label: modeLabels[mode],
            icon: 'git-branch-outline' as const,
            testID: `files-changes-mode-${mode}`,
            selected: selection.mode === mode,
            onPress: () => onSelectionChange({ mode }),
          })),
          { label: '刷新更改', icon: 'refresh', testID: 'files-changes-refresh', onPress: refresh },
        ]}
      />
      <View style={[styles.tabs, { borderBottomColor: theme.colors.outlineVariant }]}>
        <FileSegments
          value="changes"
          onChange={value => {
            if (value === 'files') onFiles()
          }}
          items={[
            { value: 'changes', label: '已修改', testID: 'files-tab-changes' },
            { value: 'files', label: '所有文件', testID: 'files-tab-files' },
          ]}
        />
      </View>
      {loading ? (
        <ActivityIndicator
          style={styles.loading}
          testID="files-changes-loading"
          color={theme.colors.onSurfaceVariant}
        />
      ) : null}
      {error ? (
        <FileErrorState
          title="暂时无法读取更改"
          message={error}
          testID="files-changes-error"
          retryTestID="files-changes-retry"
          onRetry={refresh}
          compact
        />
      ) : null}
      {changes?.fileCount ? (
        <FlatList
          style={styles.screen}
          contentContainerStyle={styles.cards}
          data={changes.files}
          keyExtractor={file => file.path}
          testID="files-changes-list"
          renderItem={({ item }) => (
            <ChangedFileCard file={item} deferInline={deferInline} onOpen={() => openFile(item)} />
          )}
        />
      ) : !loading && !error && changes ? (
        <View style={styles.empty} testID="files-changes-empty">
          <Ionicons
            name="checkmark-circle-outline"
            size={44}
            color={theme.colors.onSurfaceVariant}
          />
          <Text variant="titleLarge" style={styles.emptyTitle}>
            {emptyLabels[selection.mode]}
          </Text>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            代码更改将显示在此处。
          </Text>
        </View>
      ) : (
        <View style={styles.screen} />
      )}
      {selection.mode === 'branch' ? (
        <BranchComparison
          api={api}
          target={target}
          branchName={changes?.branchName}
          baseRef={selection.baseRef}
          onSelect={baseRef => onSelectionChange({ mode: 'branch', baseRef })}
        />
      ) : null}
    </View>
  )
}

function DiffCounts({ additions, deletions }: { additions: number; deletions: number }) {
  const theme = useTheme()
  return (
    <View style={styles.counts}>
      <Text variant="bodySmall" style={{ color: theme.dark ? '#74c878' : '#3f923b' }}>
        +{additions}
      </Text>
      <Text variant="bodySmall" style={{ color: theme.dark ? '#f07885' : '#d34c5b' }}>
        −{deletions}
      </Text>
    </View>
  )
}

function ChangedFileCard({
  file,
  deferInline,
  onOpen,
}: {
  file: MobileWorkspaceChangedFile
  deferInline: boolean
  onOpen: () => void
}) {
  const theme = useTheme()
  const parts = file.path.split('/')
  const name = parts.pop()
  const directory = parts.join('/')
  const hunkStart = file.lines.findIndex(line => line.startsWith('@@'))
  const binary = file.lines.some(
    line => line.startsWith('Binary files ') || line === 'GIT binary patch'
  )
  const deferred = deferInline || file.lines.length > INLINE_FILE_LINE_BUDGET
  return (
    <View style={styles.card} testID={`files-change-${file.path}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看 ${file.path} 的更改`}
        testID={`files-change-open-${file.path}`}
        onPress={onOpen}
        style={[
          styles.cardHeader,
          { backgroundColor: theme.dark ? theme.colors.surfaceVariant : '#e9e9e9' },
        ]}
      >
        <View style={styles.grow}>
          <Text variant="bodyMedium" numberOfLines={1} style={styles.fileName}>
            {name}
          </Text>
          {directory ? (
            <Text
              variant="bodySmall"
              numberOfLines={1}
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {directory}
            </Text>
          ) : null}
        </View>
        <DiffCounts additions={file.additions} deletions={file.deletions} />
        <Ionicons name="open-outline" size={22} color={theme.colors.onSurface} />
      </Pressable>
      {deferred ? (
        <Text
          variant="bodySmall"
          style={[styles.deferred, { color: theme.colors.onSurfaceVariant }]}
        >
          为确保评审保持响应迅速，未以内联方式加载此差异。
        </Text>
      ) : binary ? (
        <Text
          variant="bodySmall"
          style={[styles.deferred, { color: theme.colors.onSurfaceVariant }]}
        >
          二进制文件已更改。
        </Text>
      ) : hunkStart < 0 ? (
        <Text
          variant="bodySmall"
          style={[styles.deferred, { color: theme.colors.onSurfaceVariant }]}
        >
          {file.oldPath && file.oldPath !== file.path
            ? `重命名自 ${file.oldPath}`
            : '文件属性已更改。'}
        </Text>
      ) : (
        <ScrollView horizontal testID={`files-change-inline-${file.path}`}>
          <View style={styles.inlineDiff}>
            {file.lines.slice(hunkStart).map((line, index) => (
              <Text
                key={index}
                variant="bodySmall"
                style={[
                  styles.code,
                  {
                    color: theme.colors.onSurface,
                    backgroundColor: line.startsWith('+')
                      ? theme.dark
                        ? '#193722'
                        : '#e8f5e9'
                      : line.startsWith('-')
                        ? theme.dark
                          ? '#402126'
                          : '#fce8e9'
                        : undefined,
                  },
                ]}
              >
                {line}
              </Text>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  )
}

function BranchComparison({
  api,
  target,
  branchName,
  baseRef,
  onSelect,
}: {
  api: RuntimeApi
  target: MobileWorkspaceFileTarget
  branchName?: string
  baseRef?: string
  onSelect: (branch: string) => void
}) {
  const theme = useTheme()
  const { height, width } = useWindowDimensions()
  const [visible, setVisible] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setBranches([])
    void listMobileWorkspaceBranches(api, target, controller.signal)
      .then(
        values => {
          if (!controller.signal.aborted) setBranches(values)
        },
        cause => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause))
        }
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [api, target, visible, revision])
  return (
    <View style={[styles.comparison, { borderTopColor: theme.colors.outlineVariant }]}>
      <Text
        variant="bodyLarge"
        numberOfLines={1}
        style={[styles.branch, { color: theme.colors.onSurfaceVariant }]}
      >
        {branchName || '…'}
      </Text>
      <Ionicons name="arrow-forward" size={24} color={theme.colors.onSurfaceVariant} />
      <View style={styles.grow}>
        <Menu
          visible={visible}
          onDismiss={() => setVisible(false)}
          anchorPosition="top"
          statusBarHeight={0}
          contentStyle={{ maxWidth: width - 32, backgroundColor: theme.colors.elevation.level2 }}
          anchor={
            <Pressable
              style={styles.baseBranch}
              accessibilityRole="button"
              accessibilityLabel="选择比较分支"
              testID="files-changes-base"
              onPress={() => setVisible(true)}
            >
              <Text
                variant="bodyLarge"
                numberOfLines={1}
                style={[styles.branch, { color: theme.colors.onSurfaceVariant }]}
              >
                {baseRef || '主分支'}
              </Text>
              <Ionicons name="chevron-down" size={14} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          }
        >
          <ScrollView style={{ maxHeight: height * 0.5 }} keyboardShouldPersistTaps="handled">
            {loading ? (
              <ActivityIndicator testID="files-branches-loading" style={styles.loading} />
            ) : null}
            {error ? (
              <View style={styles.branchError}>
                <Text variant="bodySmall">{error}</Text>
                <FileTextAction
                  label="重试"
                  testID="files-branches-retry"
                  onPress={() => setRevision(value => value + 1)}
                />
              </View>
            ) : (
              branches.map(branch => (
                <Menu.Item
                  key={branch}
                  testID={`files-branch-${branch}`}
                  title={branch}
                  titleStyle={theme.fonts.bodyMedium}
                  style={styles.branchItem}
                  trailingIcon={branch === baseRef ? 'check' : undefined}
                  onPress={() => {
                    setVisible(false)
                    onSelect(branch)
                  }}
                />
              ))
            )}
            {!loading && !error && !branches.length ? (
              <Text variant="bodyMedium" style={styles.branchError}>
                没有可用的比较分支
              </Text>
            ) : null}
          </ScrollView>
        </Menu>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  subtitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tabs: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loading: { paddingVertical: 12 },
  cards: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },
  card: { marginBottom: 16, overflow: 'hidden', borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  cardHeader: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
  },
  fileName: { fontWeight: '600' },
  deferred: { paddingHorizontal: 16, paddingVertical: 16 },
  inlineDiff: { paddingVertical: 4, minWidth: '100%' },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', paddingHorizontal: 12 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 16,
    gap: 4,
    paddingHorizontal: 24,
  },
  emptyTitle: { textAlign: 'center', marginTop: 20 },
  comparison: {
    minHeight: 56,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
  },
  branch: { flexShrink: 1 },
  baseBranch: { flexDirection: 'row', minHeight: 44, alignItems: 'center', gap: 6 },
  branchItem: { minHeight: 44 },
  branchError: { padding: 16 },
})
