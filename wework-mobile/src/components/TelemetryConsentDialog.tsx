import { useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Button, Dialog, Portal, Text, useTheme } from 'react-native-paper'
import type { MobileTelemetrySnapshot } from '@/telemetry/mobileTelemetry'

export function TelemetryConsentDialog({
  snapshot,
  onChoose,
}: {
  snapshot: MobileTelemetrySnapshot
  onChoose: (enabled: boolean) => Promise<void>
}) {
  const theme = useTheme()
  const [failure, setFailure] = useState(false)
  const choose = async (enabled: boolean) => {
    setFailure(false)
    try {
      await onChoose(enabled)
    } catch {
      setFailure(true)
    }
  }
  return (
    <Portal>
      <Dialog visible dismissable={false} style={styles.dialog}>
        <Dialog.Title>帮助改进 WeWork</Dialog.Title>
        <Dialog.Content style={styles.content}>
          <Text variant="bodyMedium">
            是否允许发送匿名的安装、使用时长、启动与卡顿、任务结果数据？这些数据用于了解使用情况和改进稳定性。
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            不会采集聊天、提示词、模型回复、代码、文件名、文件路径、终端内容或凭据。你可以随时在设置中修改。
          </Text>
          {failure && (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              选择尚未保存，请稍后重试。
            </Text>
          )}
          {snapshot.saving && <ActivityIndicator style={styles.pending} />}
        </Dialog.Content>
        <Dialog.Actions>
          <Button
            testID="telemetry-consent-decline"
            disabled={snapshot.saving}
            onPress={() => void choose(false)}
            contentStyle={styles.action}
          >
            不共享
          </Button>
          <Button
            testID="telemetry-consent-accept"
            mode="contained"
            disabled={snapshot.saving}
            onPress={() => void choose(true)}
            contentStyle={styles.action}
          >
            允许共享
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  )
}

const styles = StyleSheet.create({
  dialog: { marginHorizontal: 24 },
  content: { gap: 14 },
  pending: { alignSelf: 'center' },
  action: { minHeight: 48 },
})
