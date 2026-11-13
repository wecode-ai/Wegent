import Ionicons from '@expo/vector-icons/Ionicons'
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { LiquidGlassButton } from './LiquidGlass'

interface WorkbenchSidebarProps {
  visible: boolean
  userLabel: string
  onDismiss: () => void
  onSettings: () => void
}

export function WorkbenchSidebar({
  visible,
  userLabel,
  onDismiss,
  onSettings,
}: WorkbenchSidebarProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal
      animationType="fade"
      navigationBarTranslucent
      onRequestClose={onDismiss}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.layer}>
        <Pressable
          accessibilityLabel="关闭侧边栏"
          accessibilityRole="button"
          onPress={onDismiss}
          style={styles.dismiss}
          testID="workbench-sidebar-dismiss"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.panel,
            {
              backgroundColor: theme.colors.background,
              paddingTop: insets.top + 8,
              paddingBottom: Math.max(insets.bottom, 16),
            },
          ]}
          testID="workbench-sidebar"
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.onBackground }]}>Wework</Text>
            <LiquidGlassButton
              accessibilityLabel="关闭侧边栏"
              colorScheme={theme.dark ? 'dark' : 'light'}
              contentStyle={styles.closeContent}
              fallbackStyle={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.outlineVariant,
              }}
              onPress={onDismiss}
              style={styles.close}
              testID="workbench-sidebar-close"
            >
              <Ionicons name="close" size={22} color={theme.colors.onBackground} />
            </LiquidGlassButton>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: true }}
            onPress={onDismiss}
            style={[styles.entry, { backgroundColor: theme.colors.surfaceVariant }]}
            testID="workbench-sidebar-home"
          >
            <Image
              source={require('../../assets/wework-logo-transparent.png')}
              style={styles.logo}
            />
            <Text variant="bodyLarge" style={styles.entryTitle}>
              Wework
            </Text>
          </Pressable>
          <View style={styles.spacer} />
          <Pressable
            accessibilityLabel="设置"
            accessibilityRole="button"
            onPress={() => {
              onDismiss()
              onSettings()
            }}
            style={styles.account}
            testID="workbench-sidebar-settings"
          >
            <View style={[styles.avatar, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Text style={styles.initial}>
                {userLabel.trim().slice(0, 1).toLocaleUpperCase() || 'W'}
              </Text>
            </View>
            <Text numberOfLines={1} style={styles.accountName} variant="bodyLarge">
              {userLabel || 'Wework'}
            </Text>
            <Ionicons color={theme.colors.onSurfaceVariant} name="settings-outline" size={22} />
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  layer: { flex: 1 },
  dismiss: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.12)' },
  panel: {
    width: '78%',
    maxWidth: 360,
    flex: 1,
    borderTopRightRadius: 30,
    borderBottomRightRadius: 30,
    paddingHorizontal: 16,
  },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 8,
    marginBottom: 28,
  },
  title: { fontSize: 22, fontWeight: '600', letterSpacing: -0.5 },
  close: { width: 44, height: 44, borderRadius: 22 },
  closeContent: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  entry: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logo: { width: 24, height: 24, resizeMode: 'contain' },
  entryTitle: { fontWeight: '600' },
  spacer: { flex: 1 },
  account: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { fontSize: 16, fontWeight: '500' },
  accountName: { flex: 1 },
})
