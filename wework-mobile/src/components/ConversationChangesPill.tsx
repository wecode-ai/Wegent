import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { AppState, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import type { MobileWorkspaceChanges } from '@/types/workspaceGit'
import { WorkspaceNotGitRepositoryError } from '@/services/mobileWorkspaceGit'
import { LiquidGlassButton } from './LiquidGlass'
import { useMobileFilePreview } from './files/FilePreviewContext'

type ChangesState =
  | { key: string; status: 'ready'; changes: MobileWorkspaceChanges }
  | { key: string; status: 'loading' | 'error' | 'not-git' }

/** Owns only the active conversation's Git summary; opening the sheet reloads its full state. */
export function ConversationChangesPill({ revision }: { revision: string }) {
  const preview = useMobileFilePreview()
  const theme = useTheme()
  const [state, setState] = useState<ChangesState | null>(null)
  const target = preview?.target
  const loadChanges = preview?.loadChanges
  const key = JSON.stringify([target?.deviceId, target?.path, revision])
  useFocusEffect(
    useCallback(() => {
      if (!target || !loadChanges) return
      let controller: AbortController | null = null
      const load = () => {
        controller?.abort()
        const current = new AbortController()
        controller = current
        setState({ key, status: 'loading' })
        void loadChanges({ mode: 'branch' }, current.signal).then(
          changes => {
            if (!current.signal.aborted) setState({ key, status: 'ready', changes })
          },
          cause => {
            if (!current.signal.aborted)
              setState({
                key,
                status: cause instanceof WorkspaceNotGitRepositoryError ? 'not-git' : 'error',
              })
          }
        )
      }
      load()
      const listener = AppState.addEventListener('change', value => {
        if (value === 'active') load()
      })
      return () => {
        controller?.abort()
        listener.remove()
      }
    }, [key, loadChanges, target])
  )
  if (!target || !preview) return null
  const current = state?.key === key ? state : null
  if (
    current?.status === 'not-git' ||
    (current?.status === 'ready' && current.changes.fileCount === 0)
  )
    return null
  return (
    <View style={styles.touchArea}>
      <LiquidGlassButton
        accessibilityLabel={
          current?.status === 'ready'
            ? `${current.changes.fileCount} 个文件，新增 ${current.changes.additions} 行，删除 ${current.changes.deletions} 行`
            : current?.status === 'error'
              ? '更改加载失败，打开重试'
              : '查看文件更改'
        }
        colorScheme={theme.dark ? 'dark' : 'light'}
        contentStyle={styles.content}
        fallbackStyle={{
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.outlineVariant,
        }}
        hitSlop={{ top: 7, bottom: 7 }}
        onPress={() => preview.openChangesBrowser()}
        style={styles.pill}
        testID="conversation-changes"
      >
        <Text style={[styles.label, { color: theme.colors.onSurfaceVariant }]}>
          {current?.status === 'ready'
            ? `${current.changes.fileCount} 个文件`
            : current?.status === 'error'
              ? '更改 · 加载失败'
              : '更改'}
        </Text>
        {current?.status === 'ready' ? (
          <>
            <Text style={[styles.label, { color: theme.dark ? '#72c879' : '#3b8c3c' }]}>
              +{current.changes.additions}
            </Text>
            <Text style={[styles.label, { color: theme.dark ? '#ff858b' : '#cf4658' }]}>
              −{current.changes.deletions}
            </Text>
          </>
        ) : null}
      </LiquidGlassButton>
    </View>
  )
}

const styles = StyleSheet.create({
  touchArea: { minHeight: 44, justifyContent: 'center' },
  pill: { height: 30, borderRadius: 15, overflow: 'hidden' },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    height: 30,
  },
  label: { fontSize: 12, lineHeight: 17 },
})
