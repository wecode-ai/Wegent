import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Portal, Text, useTheme } from 'react-native-paper'

import { LiquidGlassSurface } from './LiquidGlass'

export interface MessageMenuAnchor {
  x: number
  y: number
}

interface MessageContextMenuProps {
  anchor: MessageMenuAnchor | null
  onCopy: () => void
  onDismiss: () => void
}

const MENU_WIDTH = 112
const MENU_HEIGHT = 52
const EDGE_INSET = 12
const ANCHOR_GAP = 10

export function MessageContextMenu({ anchor, onCopy, onDismiss }: MessageContextMenuProps) {
  const theme = useTheme()
  const { height, width } = useWindowDimensions()

  if (!anchor) return null

  const left = Math.max(
    EDGE_INSET,
    Math.min(anchor.x - MENU_WIDTH / 2, width - MENU_WIDTH - EDGE_INSET)
  )
  const fitsBelow = anchor.y + ANCHOR_GAP + MENU_HEIGHT <= height - EDGE_INSET
  const top = fitsBelow
    ? anchor.y + ANCHOR_GAP
    : Math.max(EDGE_INSET, anchor.y - MENU_HEIGHT - ANCHOR_GAP)

  return (
    <Portal>
      <Pressable
        accessibilityLabel="关闭消息菜单"
        accessibilityRole="button"
        onPress={onDismiss}
        style={styles.backdrop}
        testID="message-menu-backdrop"
      >
        <Pressable
          accessibilityViewIsModal
          onPress={event => event.stopPropagation()}
          style={[styles.positioner, { left, top }]}
          testID="message-context-menu"
        >
          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{
              backgroundColor: theme.colors.elevation.level3,
              borderColor: theme.colors.outlineVariant,
            }}
            glassEffectStyle="regular"
            isInteractive
            style={styles.glass}
          >
            <Pressable
              accessibilityLabel="复制消息"
              accessibilityRole="button"
              onPress={onCopy}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
              testID="message-copy"
            >
              <View style={styles.iconCircle}>
                <Ionicons color={theme.colors.onSurface} name="copy-outline" size={17} />
              </View>
              <Text style={styles.label} variant="titleMedium">
                复制
              </Text>
            </Pressable>
          </LiquidGlassSurface>
        </Pressable>
      </Pressable>
    </Portal>
  )
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', inset: 0 },
  positioner: { position: 'absolute', width: MENU_WIDTH },
  glass: { padding: 4, borderRadius: 18, overflow: 'hidden' },
  action: {
    height: 44,
    paddingHorizontal: 7,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  actionPressed: { backgroundColor: 'rgba(128,128,128,0.16)' },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.18)',
  },
  label: { flex: 1, fontSize: 15, fontWeight: '500' },
})
