import Ionicons from '@expo/vector-icons/Ionicons'
import { useRef } from 'react'
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
import type { MenuAnchor } from '@/domain/conversationMenuGeometry'

interface ConversationHeaderProps {
  backAccessibilityLabel?: string
  minimal?: boolean
  title: string
  projectName: string | null
  deviceName: string | null
  onBack: () => void
  onLayout?: (event: LayoutChangeEvent) => void
  onNewConversation: () => void
  canCreateConversation?: boolean
  onMore: (anchor: MenuAnchor) => void
  menuExpanded?: boolean
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
  canCreateConversation = true,
  onMore,
  menuExpanded = false,
  style,
}: ConversationHeaderProps) {
  const theme = useTheme()
  const capsule = useRef<View>(null)
  const measuring = useRef(false)
  const openMore = () => {
    if (menuExpanded || measuring.current || !capsule.current) return
    measuring.current = true
    capsule.current?.measureInWindow((x, y, width, height) => {
      measuring.current = false
      if (width > 0 && height > 0) onMore({ x, y, width, height })
    })
  }

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
      {minimal ? (
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <View
            ref={capsule}
            collapsable={false}
            pointerEvents={menuExpanded ? 'none' : 'auto'}
            accessibilityElementsHidden={menuExpanded}
            importantForAccessibility={menuExpanded ? 'no-hide-descendants' : 'auto'}
            style={{ width: 44, height: 44, opacity: menuExpanded ? 0 : 1 }}
            testID="conversation-menu-anchor"
          >
            <LiquidGlassSurface
              colorScheme={theme.dark ? 'dark' : 'light'}
              fallbackStyle={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.outlineVariant,
              }}
              style={styles.minimalCapsule}
            >
              <HeaderAction
                accessibilityLabel="更多"
                icon="ellipsis-horizontal"
                onPress={openMore}
                testID="more-actions"
              />
            </LiquidGlassSurface>
          </View>
        </View>
      ) : null}

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
            <View style={styles.subtitleRow}>
              {deviceName ? (
                <Text
                  ellipsizeMode="tail"
                  numberOfLines={1}
                  style={[
                    styles.subtitle,
                    styles.deviceName,
                    { color: theme.colors.onSurfaceVariant },
                  ]}
                  testID="conversation-header-device"
                >
                  {deviceName}
                </Text>
              ) : null}
              {deviceName && projectName ? (
                <Text style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                  {' · '}
                </Text>
              ) : null}
              {projectName ? (
                <Text
                  ellipsizeMode="tail"
                  numberOfLines={1}
                  style={[
                    styles.subtitle,
                    styles.projectName,
                    { color: theme.colors.onSurfaceVariant },
                  ]}
                  testID="conversation-header-project"
                >
                  {projectName}
                </Text>
              ) : null}
            </View>
          </View>

          <View
            ref={capsule}
            collapsable={false}
            pointerEvents={menuExpanded ? 'none' : 'auto'}
            accessibilityElementsHidden={menuExpanded}
            importantForAccessibility={menuExpanded ? 'no-hide-descendants' : 'auto'}
            style={[styles.actionCapsule, menuExpanded && { opacity: 0 }]}
            testID="conversation-menu-anchor"
          >
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
                  disabled={!canCreateConversation}
                  icon="create-outline"
                  onPress={onNewConversation}
                  testID="new-conversation"
                />
                <HeaderAction
                  accessibilityLabel="更多"
                  icon="ellipsis-horizontal"
                  onPress={openMore}
                  testID="more-actions"
                />
              </View>
            </LiquidGlassSurface>
          </View>
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
  disabled = false,
}: {
  accessibilityLabel: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  testID: string
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        pressed && styles.pressed,
        disabled && { opacity: 0.35 },
      ]}
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
    gap: 12,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  glassButtonContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  subtitle: { fontSize: 12, lineHeight: 17, fontWeight: '400' },
  deviceName: { flexShrink: 1 },
  projectName: { maxWidth: '50%' },
  actionCapsule: {
    width: 108,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  minimalCapsule: { flex: 1, borderRadius: 22 },
  actionRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center' },
  pressed: { transform: [{ scale: 0.94 }] },
})
