import Ionicons from '@expo/vector-icons/Ionicons'
import {
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { LiquidGlassButton, LiquidGlassGroup, LiquidGlassSurface } from './LiquidGlass'

interface ConversationHeaderProps {
  backAccessibilityLabel?: string
  minimal?: boolean
  title: string
  projectName: string | null
  deviceName: string | null
  onBack: () => void
  onLayout?: (event: LayoutChangeEvent) => void
  onNewConversation: () => void
  onMore: () => void
  style?: StyleProp<ViewStyle>
}

export const CONVERSATION_HEADER_HEIGHT = 44

export function ConversationHeader({
  backAccessibilityLabel = '返回会话列表',
  minimal = false,
  title,
  projectName,
  deviceName,
  onBack,
  onLayout,
  onNewConversation,
  onMore,
  style,
}: ConversationHeaderProps) {
  const theme = useTheme()
  const subtitle = [projectName ?? '聊天', deviceName].filter(Boolean).join(' · ')

  return (
    <LiquidGlassGroup
      onLayout={onLayout}
      spacing={10}
      style={[styles.header, style]}
      testID="conversation-header"
    >
      <GlassButton
        accessibilityLabel={backAccessibilityLabel}
        icon="chevron-back"
        onPress={onBack}
        testID="open-drawer"
      />

      {minimal ? null : (
        <>
          <View style={styles.titleBlock}>
            <Text
              ellipsizeMode="tail"
              numberOfLines={1}
              style={[styles.title, { color: theme.colors.onBackground }]}
            >
              {title}
            </Text>
            <Text
              ellipsizeMode="tail"
              numberOfLines={1}
              style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
            >
              {subtitle}
            </Text>
          </View>

          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outlineVariant,
            }}
            style={styles.actionCapsule}
          >
            <View style={styles.actionRow}>
              <HeaderAction
                accessibilityLabel="新会话"
                icon="create-outline"
                onPress={onNewConversation}
                testID="new-conversation"
              />
              <HeaderAction
                accessibilityLabel="更多"
                icon="ellipsis-horizontal"
                onPress={onMore}
                testID="more-actions"
              />
            </View>
          </LiquidGlassSurface>
        </>
      )}
    </LiquidGlassGroup>
  )
}

function GlassButton({
  accessibilityLabel,
  icon,
  onPress,
  testID,
}: {
  accessibilityLabel: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  return (
    <LiquidGlassButton
      accessibilityLabel={accessibilityLabel}
      colorScheme={theme.dark ? 'dark' : 'light'}
      contentStyle={styles.glassButtonContent}
      fallbackStyle={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.outlineVariant,
      }}
      hitSlop={8}
      onPress={onPress}
      style={styles.backButton}
      testID={testID}
    >
      <Ionicons color={theme.colors.onSurface} name={icon} size={25} />
    </LiquidGlassButton>
  )
}

function HeaderAction({
  accessibilityLabel,
  icon,
  onPress,
  testID,
}: {
  accessibilityLabel: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons color={theme.colors.onSurface} name={icon} size={25} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    height: CONVERSATION_HEADER_HEIGHT,
    marginHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  glassButtonContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  subtitle: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  actionCapsule: {
    width: 100,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  actionRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center' },
  pressed: { transform: [{ scale: 0.94 }] },
})
