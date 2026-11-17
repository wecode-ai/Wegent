import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { describeMobileError } from '@/domain/errorPresentation'
import { copyErrorDetails, showErrorAlert } from '@/services/errorAlerts'

export function ErrorNotice({
  error,
  errorType,
  title,
  testID = 'error-notice',
  retryTestID = `${testID}-retry`,
  detailsTestID = `${testID}-copy-details`,
  onRetry,
}: {
  error: unknown
  errorType?: string
  title?: string
  testID?: string
  retryTestID?: string
  detailsTestID?: string
  onRetry?: () => void | Promise<unknown>
}) {
  const theme = useTheme()
  const presentation = describeMobileError(error, title, errorType)
  return (
    <View testID={testID} style={[styles.notice, { backgroundColor: theme.colors.surfaceVariant }]}>
      <Ionicons
        accessible={false}
        importantForAccessibility="no"
        name="alert-circle-outline"
        size={20}
        color={theme.colors.error}
      />
      <View style={styles.content}>
        <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
            {presentation.title}
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
            {presentation.message}
          </Text>
        </View>
        {(onRetry || presentation.details) && (
          <View style={styles.actions}>
            {onRetry && (
              <Pressable
                accessibilityRole="button"
                testID={retryTestID}
                style={styles.action}
                onPress={() =>
                  Promise.resolve()
                    .then(onRetry)
                    .catch(cause => {
                      showErrorAlert(cause, { title, onRetry })
                    })
                }
              >
                <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                  重试
                </Text>
              </Pressable>
            )}
            {presentation.details && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="复制错误详情"
                testID={detailsTestID}
                style={styles.action}
                onPress={() => copyErrorDetails(presentation.details!)}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                  复制详情
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  notice: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 12,
  },
  content: { flex: 1, minWidth: 0, gap: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  action: { minWidth: 48, minHeight: 48, justifyContent: 'center' },
})
