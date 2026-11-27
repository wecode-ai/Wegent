import { useState } from 'react'
import { StyleSheet, Switch, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { mobileTelemetry } from '@/telemetry/mobileTelemetry'
import { useMobileTelemetryState } from '@/telemetry/useMobileTelemetry'
import { ErrorNotice } from './errors/ErrorNotice'

export function TelemetryPrivacySettings() {
  const theme = useTheme()
  const telemetry = useMobileTelemetryState()
  const [error, setError] = useState<unknown>(null)
  const [failedChoice, setFailedChoice] = useState<boolean | null>(null)
  if (!telemetry.available && telemetry.error == null) return null
  const change = async (enabled: boolean) => {
    setError(null)
    try {
      await mobileTelemetry.choose(enabled)
      setFailedChoice(null)
    } catch (cause) {
      setFailedChoice(enabled)
      setError(cause)
    }
  }
  return (
    <View style={styles.content}>
      <View style={styles.row}>
        <Text variant="bodyLarge" style={styles.label}>
          帮助改进 WeWork
        </Text>
        <Switch
          testID="settings-telemetry-toggle"
          accessibilityLabel="共享匿名使用数据"
          value={telemetry.enabled}
          disabled={!telemetry.available || !telemetry.ready || telemetry.saving}
          onValueChange={value => {
            void change(value)
          }}
        />
      </View>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        发送匿名的安装、使用时长、启动与卡顿、任务结果数据。不会采集聊天、代码、文件路径、终端内容或凭据。
      </Text>
      <View style={[styles.separator, { backgroundColor: theme.colors.outlineVariant }]} />
      {(error != null || telemetry.error != null) && (
        <ErrorNotice
          error={error ?? telemetry.error}
          onRetry={() => {
            if (failedChoice !== null) void change(failedChoice)
            else void mobileTelemetry.retry()
          }}
          testID="settings-telemetry-error"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { flex: 1 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 36 },
})
