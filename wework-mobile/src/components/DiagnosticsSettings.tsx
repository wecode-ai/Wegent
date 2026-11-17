import { useState } from 'react'
import { StyleSheet, Switch, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useMobileDiagnostics } from '@/hooks/useMobileDiagnostics'
import { ErrorNotice } from './errors/ErrorNotice'

export function DiagnosticsSettings() {
  const theme = useTheme()
  const diagnostics = useMobileDiagnostics()
  const [error, setError] = useState<unknown>(null)
  const change = async (value: boolean) => {
    try {
      await diagnostics.change(value)
      setError(null)
    } catch (cause) {
      setError(cause)
    }
  }
  return (
    <View style={styles.content}>
      <View style={styles.row}>
        <Text variant="bodyLarge" style={styles.label}>
          诊断日志
        </Text>
        <Switch
          testID="settings-diagnostics-toggle"
          accessibilityLabel="诊断日志"
          value={diagnostics.enabled}
          disabled={!diagnostics.ready || diagnostics.changing || Boolean(diagnostics.error)}
          onValueChange={value => {
            void change(value)
          }}
        />
      </View>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        默认关闭。排查连接、消息或键盘问题时开启，排查结束后可关闭。系统和模型运行时可能仍保留错误日志。
      </Text>
      {(error != null || diagnostics.error != null) && (
        <ErrorNotice
          error={error ?? diagnostics.error}
          onRetry={diagnostics.error ? diagnostics.retry : undefined}
          testID="settings-diagnostics-error"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { flex: 1 },
})
