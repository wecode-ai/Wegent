import { StyleSheet, View } from 'react-native'
import { Button, Text, useTheme } from 'react-native-paper'
import { MODEL_DATA_SHARING_NOTICE, openPrivacyPolicy } from '@/services/privacyPolicy'

export function ModelPrivacyNotice({ testID }: { testID: string }) {
  const theme = useTheme()
  return (
    <View testID={testID} style={styles.notice}>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {MODEL_DATA_SHARING_NOTICE}
      </Text>
      <Button
        testID={`${testID}-read`}
        onPress={() => void openPrivacyPolicy()}
        style={styles.link}
        contentStyle={styles.linkContent}
      >
        阅读隐私政策
      </Button>
    </View>
  )
}

const styles = StyleSheet.create({
  notice: { gap: 4 },
  link: { alignSelf: 'flex-start' },
  linkContent: { minHeight: 48 },
})
