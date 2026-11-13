import { useEffect, useState, type ReactNode } from 'react'
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { modelPopoverLayout, type ModelMenuAnchor } from '@/domain/modelPopoverLayout'
import { ModelControlSurface } from './ModelControlSurface'

interface ModelOptionPopoverProps {
  anchor: ModelMenuAnchor
  children: ReactNode
  kind: string
  onDismiss: () => void
  viewport: { width: number; height: number; topInset: number; bottomInset: number }
}

export function ModelOptionPopover({
  anchor,
  children,
  kind,
  onDismiss,
  viewport,
}: ModelOptionPopoverProps) {
  const [contentHeight, setContentHeight] = useState(0)
  const frame = modelPopoverLayout(anchor, viewport, contentHeight)
  const measured = contentHeight > 0

  useEffect(() => {
    if (Platform.OS !== 'android') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss()
      return true
    })
    return () => subscription.remove()
  }, [onDismiss])

  return (
    <View style={StyleSheet.absoluteFill} testID={`${kind}-menu-layer`}>
      <Pressable
        accessibilityLabel="关闭选项菜单"
        accessibilityRole="button"
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
        testID={`${kind}-menu-backdrop`}
      />
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        onAccessibilityEscape={onDismiss}
        pointerEvents={measured ? 'auto' : 'none'}
        style={[styles.positioner, frame, measured && styles.shadow]}
        testID={`${kind}-menu-popover`}
      >
        <ModelControlSurface
          showBackground={measured}
          style={styles.surface}
          testID={`${kind}-menu-surface`}
        >
          <ScrollView
            accessibilityElementsHidden={!measured}
            contentContainerStyle={styles.content}
            importantForAccessibility={measured ? 'auto' : 'no-hide-descendants'}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={(_width, height) => setContentHeight(height)}
            showsVerticalScrollIndicator={false}
            style={[styles.scroll, !measured && styles.measuringContent]}
            testID={`${kind}-menu-scroll`}
          >
            {children}
          </ScrollView>
        </ModelControlSurface>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  positioner: {
    position: 'absolute',
    borderRadius: 32,
  },
  shadow: { boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.12)' },
  surface: { flex: 1, borderRadius: 32, overflow: 'hidden' },
  scroll: { flex: 1 },
  // UIKit visual effects must not mount below a transparent ancestor.
  measuringContent: { opacity: 0 },
  content: { paddingVertical: 8 },
})
