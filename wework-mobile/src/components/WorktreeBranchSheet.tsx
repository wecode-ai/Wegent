import { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import { branchMatchesQuery } from '../../../packages/chat-core/src/workspace-branches'
import { ChoiceSheet } from './ChoiceSheet'
import { ErrorNotice } from './errors/ErrorNotice'

interface WorktreeBranchSheetProps {
  currentBranch: string | null
  selectedBranch: string | null
  visible: boolean
  onListBranches: () => Promise<string[]>
  onDismiss: () => void
  onSelectBranch: (branch: string | null) => void
}

export function WorktreeBranchSheet({
  currentBranch,
  selectedBranch,
  visible,
  onListBranches,
  onDismiss,
  onSelectBranch,
}: WorktreeBranchSheetProps) {
  const theme = useTheme()
  const [branches, setBranches] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!visible) {
      setQuery('')
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    void onListBranches()
      .then(items => {
        if (active) setBranches(items)
      })
      .catch(cause => {
        if (active) setError(cause)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onListBranches, revision, visible])
  const matches = branches.filter(branch => branchMatchesQuery(branch, query))

  return (
    <ChoiceSheet
      choices={
        loading || error
          ? []
          : matches.map(branch => ({
              id: branch,
              label: branch,
              icon: 'git-branch-outline',
              selected: branch === (selectedBranch ?? currentBranch),
              onPress: () => onSelectBranch(branch === currentBranch ? null : branch),
            }))
      }
      onDismiss={onDismiss}
      testIDPrefix="new-chat-branch-choice"
      title="启动分支"
      visible={visible}
    >
      <View style={styles.content}>
        <TextInput
          accessibilityLabel="搜索分支"
          placeholder="搜索分支"
          placeholderTextColor={theme.colors.onSurfaceVariant}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          style={[
            styles.search,
            { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
          ]}
          testID="new-chat-branch-search"
          value={query}
        />
        {loading ? (
          <ActivityIndicator accessibilityLabel="正在加载分支" testID="new-chat-branches-loading" />
        ) : null}
        {error ? (
          <ErrorNotice
            error={error}
            title="无法加载分支"
            onRetry={() => setRevision(value => value + 1)}
            testID="new-chat-branches-error"
          />
        ) : null}
        {!loading && !error && !matches.length ? (
          <Text testID="new-chat-branches-empty">没有匹配的分支</Text>
        ) : null}
      </View>
    </ChoiceSheet>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 12, gap: 12 },
  search: { minHeight: 48, borderRadius: 14, paddingHorizontal: 14 },
})
