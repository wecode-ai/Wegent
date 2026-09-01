import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { Portal, Text, useTheme } from 'react-native-paper'

import { composerLogoUrl } from '@/domain/composerApps'
import type { RuntimeComposerApp } from '@/types/runtime'
import { LiquidGlassSurface } from './LiquidGlass'

const MENU_PEEK_HEIGHT = 364

export interface ComposerMenuAnchor {
  x: number
  y: number
  width: number
  height: number
}

interface ComposerContextMenuProps {
  anchor: ComposerMenuAnchor
  goalDraftActive: boolean
  onDismiss: () => void
  onLoadApps: () => Promise<RuntimeComposerApp[]>
  onPickDocument: () => void
  onPickPhoto: () => void
  onSelectApp: (app: RuntimeComposerApp) => void
  onSetGoal: () => void
  onSetPlanMode: () => void
  onTakePhoto: () => void
  planModeActive: boolean
  visible: boolean
}

export function ComposerContextMenu({
  anchor,
  goalDraftActive,
  onDismiss,
  onLoadApps,
  onPickDocument,
  onPickPhoto,
  onSelectApp,
  onSetGoal,
  onSetPlanMode,
  onTakePhoto,
  planModeActive,
  visible,
}: ComposerContextMenuProps) {
  const theme = useTheme()
  const { height, width } = useWindowDimensions()
  const [apps, setApps] = useState<RuntimeComposerApp[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    let active = true
    setLoading(true)
    setError(null)
    void onLoadApps()
      .then(items => {
        if (active) setApps(items)
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onLoadApps, visible])

  const menuWidth = Math.min(360, width - 24)
  const left = Math.max(12, Math.min(anchor.x, width - menuWidth - 12))
  const bottom = Math.max(12, height - anchor.y + 8)
  const menuHeight = Math.max(280, Math.min(MENU_PEEK_HEIGHT, anchor.y - 24, height * 0.72))

  const run = (action: () => void) => {
    onDismiss()
    action()
  }

  if (!visible) return null

  return (
    <Portal>
      <Pressable onPress={onDismiss} style={styles.backdrop} testID="composer-menu-backdrop">
        <Pressable
          onPress={event => event.stopPropagation()}
          style={[styles.positioner, { bottom, height: menuHeight, left, width: menuWidth }]}
        >
          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{
              backgroundColor: theme.colors.elevation.level3,
              borderColor: theme.colors.outlineVariant,
            }}
            glassEffectStyle="regular"
            isInteractive
            style={styles.glassMenu}
            testID="composer-context-menu"
            tintColor={theme.dark ? '#262626' : '#f4f4f4'}
          >
            <ScrollView
              bounces={false}
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
            >
              <MenuAction
                active={planModeActive}
                icon="list-outline"
                label="方案模式"
                onPress={() => run(onSetPlanMode)}
                testID="composer-menu-plan"
              />
              <MenuAction
                active={goalDraftActive}
                icon="locate-outline"
                label="追求目标"
                onPress={() => run(onSetGoal)}
                testID="composer-menu-goal"
              />
              <MenuAction
                icon="attach-outline"
                label="文件"
                onPress={() => run(onPickDocument)}
                testID="composer-menu-file"
              />
              <MenuAction
                icon="camera-outline"
                label="相机"
                onPress={() => run(onTakePhoto)}
                testID="composer-menu-camera"
              />
              <MenuAction
                icon="images-outline"
                label="照片"
                onPress={() => run(onPickPhoto)}
                testID="composer-menu-photos"
              />

              <Text style={styles.sectionLabel} variant="labelMedium">
                插件
              </Text>
              {loading ? (
                <View style={styles.statusRow}>
                  <ActivityIndicator color={theme.colors.onSurfaceVariant} size="small" />
                  <Text style={{ color: theme.colors.onSurfaceVariant }}>正在加载插件</Text>
                </View>
              ) : error ? (
                <Text style={[styles.statusText, { color: theme.colors.error }]}>{error}</Text>
              ) : apps.length ? (
                apps.map(app => (
                  <PluginAction
                    app={app}
                    key={app.reference}
                    onPress={() => run(() => onSelectApp(app))}
                  />
                ))
              ) : (
                <Text style={[styles.statusText, { color: theme.colors.onSurfaceVariant }]}>
                  当前 Executor 没有已安装且启用的插件
                </Text>
              )}
            </ScrollView>
          </LiquidGlassSurface>
        </Pressable>
      </Pressable>
    </Portal>
  )
}

function MenuAction({
  active = false,
  icon,
  label,
  onPress,
  testID,
}: {
  active?: boolean
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.iconCircle}>
        <Ionicons color={theme.colors.onSurface} name={icon} size={22} />
      </View>
      <Text numberOfLines={1} style={styles.rowLabel} variant="titleMedium">
        {label}
      </Text>
      {active ? <Ionicons color={theme.colors.primary} name="checkmark" size={20} /> : null}
    </Pressable>
  )
}

function PluginAction({ app, onPress }: { app: RuntimeComposerApp; onPress: () => void }) {
  const theme = useTheme()
  const logoUrl = composerLogoUrl(app.logoUrl)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`composer-menu-plugin-${app.id}`}
    >
      <View style={styles.pluginIcon}>
        {logoUrl ? (
          <Image source={{ uri: logoUrl }} style={styles.logo} />
        ) : (
          <Ionicons color={theme.colors.onSurface} name="extension-puzzle-outline" size={22} />
        )}
      </View>
      <View style={styles.pluginText}>
        <Text numberOfLines={1} style={styles.rowLabel} variant="titleMedium">
          {app.name}
        </Text>
        {app.description ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.onSurfaceVariant }}
            variant="bodySmall"
          >
            {app.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', inset: 0 },
  positioner: { position: 'absolute' },
  glassMenu: { flex: 1, borderRadius: 32, overflow: 'hidden' },
  content: { paddingHorizontal: 12, paddingBottom: 18, paddingTop: 12 },
  row: {
    height: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 20,
    paddingHorizontal: 10,
  },
  pressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.18)',
  },
  pluginIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logo: { width: 36, height: 36, borderRadius: 9 },
  rowLabel: { flexShrink: 1 },
  pluginText: { minWidth: 0, flex: 1 },
  sectionLabel: { marginBottom: 4, marginLeft: 10, marginTop: 12, opacity: 0.7 },
  statusRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
  },
  statusText: { paddingHorizontal: 14, paddingVertical: 18 },
})
