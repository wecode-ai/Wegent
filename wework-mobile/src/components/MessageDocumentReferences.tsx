import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import type { CodexReference } from '../../../packages/chat-core/src/runtime'
import {
  basename,
  fileExtension,
} from '../../../packages/collaboration/src/conversation/codexReferences'
import { useMobileFilePreview } from './files/FilePreviewContext'

const VISIBLE_REFERENCES = 3

export function MessageDocumentReferences({ references }: { references: CodexReference[] }) {
  const preview = useMobileFilePreview()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  if (!references.length || !preview?.target) return null
  const visible = expanded ? references : references.slice(0, VISIBLE_REFERENCES)
  const hiddenCount = references.length - VISIBLE_REFERENCES
  return (
    <View
      style={[styles.list, { backgroundColor: theme.colors.surfaceVariant }]}
      testID="codex-reference-list"
    >
      {visible.map(reference => (
        <Pressable
          accessibilityLabel={`预览 ${reference.path}`}
          accessibilityRole="button"
          key={reference.path}
          onPress={() =>
            preview.openWorkspaceFile(
              reference.path,
              reference.lineStart ?? undefined,
              reference.lineEnd ?? undefined
            )
          }
          style={styles.row}
          testID="codex-reference-card"
        >
          <Ionicons color={theme.colors.onSurfaceVariant} name="document-text-outline" size={22} />
          <View style={styles.label}>
            <Text numberOfLines={2} variant="titleSmall">
              {basename(reference.path)}
            </Text>
            <Text variant="bodySmall">文档 · {fileExtension(reference.path).toUpperCase()}</Text>
          </View>
          <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-forward" size={16} />
        </Pressable>
      ))}
      {hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(value => !value)}
          style={styles.row}
          testID="toggle-codex-reference-list-button"
        >
          <Text variant="bodySmall">{expanded ? '收起' : `显示另外 ${hiddenCount} 个文件`}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, padding: 10, gap: 10 },
  label: { flex: 1, minWidth: 0 },
})
