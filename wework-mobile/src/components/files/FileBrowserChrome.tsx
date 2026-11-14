import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Menu, Text, useTheme } from 'react-native-paper'
import { LiquidGlassButton, LiquidGlassSurface } from '../LiquidGlass'

export interface FileMenuAction {
  label: string
  icon: React.ComponentProps<typeof Ionicons>['name']
  testID: string
  disabled?: boolean
  selected?: boolean
  onPress: () => void
}

export function FileBrowserHeader({
  title,
  path,
  detail,
  subtitle,
  onBack,
  onClose,
  actions,
  share,
}: {
  title: string
  path: string
  detail?: string
  subtitle?: ReactNode
  onBack?: () => void
  onClose: () => void
  actions: FileMenuAction[]
  share?: FileMenuAction
}) {
  const theme = useTheme()
  const { width, height } = useWindowDimensions()
  const [visible, setVisible] = useState(false)
  return (
    <View style={styles.header} testID="file-browser-header">
      {onBack ? (
        <FileGlassAction
          label="返回"
          icon="chevron-back"
          testID="file-preview-back"
          onPress={onBack}
        />
      ) : (
        <View style={styles.headerSpacer} />
      )}
      <View style={[styles.title, !onBack && styles.centeredTitle]}>
        <Menu
          visible={visible}
          onDismiss={() => setVisible(false)}
          anchorPosition="bottom"
          statusBarHeight={0}
          contentStyle={[
            styles.menu,
            { width: Math.min(320, width - 32), backgroundColor: theme.colors.elevation.level2 },
          ]}
          anchor={
            <Pressable
              onPress={() => setVisible(value => !value)}
              accessibilityRole="button"
              accessibilityLabel={`${title}，更多文件操作`}
              testID="file-preview-more"
              style={[styles.titleButton, !onBack && styles.centeredTitle]}
            >
              <View style={styles.titleRow}>
                <Text
                  variant="titleMedium"
                  style={styles.titleText}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  testID="file-preview-title"
                >
                  {title}
                </Text>
                {!onBack && subtitle ? (
                  <Ionicons name="chevron-down" size={16} color={theme.colors.onSurface} />
                ) : null}
              </View>
              {subtitle}
            </Pressable>
          }
        >
          <ScrollView style={{ maxHeight: height * 0.65 }} keyboardShouldPersistTaps="handled">
            <View style={styles.metadata}>
              <Text
                selectable
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
                testID="file-preview-full-path"
              >
                {path}
              </Text>
              {detail ? (
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {detail}
                </Text>
              ) : null}
            </View>
            {actions.map(action => (
              <Menu.Item
                key={action.testID}
                testID={action.testID}
                title={action.label}
                titleStyle={theme.fonts.bodyMedium}
                disabled={action.disabled}
                accessibilityState={{
                  disabled: Boolean(action.disabled),
                  checked: action.selected,
                }}
                style={styles.menuItem}
                leadingIcon={({ size, color }) => (
                  <Ionicons name={action.icon} size={size} color={color} />
                )}
                trailingIcon={action.selected ? 'check' : undefined}
                onPress={() => {
                  setVisible(false)
                  action.onPress()
                }}
              />
            ))}
          </ScrollView>
        </Menu>
      </View>
      {share ? (
        <LiquidGlassSurface
          colorScheme={theme.dark ? 'dark' : 'light'}
          fallbackStyle={{ backgroundColor: theme.colors.elevation.level2 }}
          style={styles.headerCapsule}
          testID="file-preview-share-close"
        >
          <FileAction {...share} />
          <FileAction label="关闭文件" icon="close" testID="file-preview-close" onPress={onClose} />
        </LiquidGlassSurface>
      ) : (
        <FileGlassAction
          label="关闭文件"
          icon="close"
          testID="file-preview-close"
          onPress={onClose}
        />
      )}
    </View>
  )
}

export function FileGlassAction({
  label,
  icon,
  testID,
  disabled,
  onPress,
  large = false,
}: FileMenuAction & { large?: boolean }) {
  const theme = useTheme()
  return (
    <LiquidGlassButton
      accessibilityLabel={label}
      colorScheme={theme.dark ? 'dark' : 'light'}
      fallbackStyle={{ backgroundColor: theme.colors.elevation.level2 }}
      style={[styles.glassAction, large && styles.largeGlassAction]}
      contentStyle={[styles.action, large && styles.largeGlassAction]}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={large ? 24 : 26}
        color={theme.colors.onSurface}
        style={disabled ? { opacity: 0.35 } : undefined}
      />
    </LiquidGlassButton>
  )
}

export function FileAction({ label, icon, testID, disabled, selected, onPress }: FileMenuAction) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), selected }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.action,
        disabled && { opacity: 0.35 },
        (pressed || selected) && { backgroundColor: theme.colors.surfaceVariant },
      ]}
    >
      <Ionicons name={icon} size={24} color={theme.colors.onSurface} />
    </Pressable>
  )
}

export function FileSegments<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T
  items: { value: T; label: string; testID: string }[]
  onChange: (value: T) => void
}) {
  const theme = useTheme()
  return (
    <View style={styles.segments}>
      <View
        pointerEvents="none"
        style={[styles.segmentTrack, { backgroundColor: theme.colors.surfaceVariant }]}
      />
      {items.map(item => (
        <Pressable
          key={item.value}
          testID={item.testID}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === item.value }}
          onPress={() => onChange(item.value)}
          style={styles.segment}
        >
          <View
            style={[
              styles.segmentLabel,
              value === item.value && { backgroundColor: theme.colors.background },
            ]}
          >
            <Text
              variant="bodyMedium"
              style={{
                color:
                  value === item.value ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
              }}
            >
              {item.label}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  )
}

export function FileErrorState({
  title,
  message,
  testID,
  retryTestID,
  onRetry,
  compact = false,
}: {
  title: string
  message: string
  testID: string
  retryTestID: string
  onRetry: () => void
  compact?: boolean
}) {
  const theme = useTheme()
  const [details, setDetails] = useState(false)
  useEffect(() => setDetails(false), [message])
  return (
    <View style={[styles.error, compact && styles.compactError]} testID={testID}>
      {!compact ? (
        <View style={[styles.errorIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Ionicons name="document-outline" size={24} color={theme.colors.onSurfaceVariant} />
        </View>
      ) : null}
      <Text variant="titleMedium" style={styles.centerText}>
        {title}
      </Text>
      <Text
        variant="bodySmall"
        style={[styles.centerText, { color: theme.colors.onSurfaceVariant }]}
      >
        请重试，或稍后重新打开。
      </Text>
      <View style={styles.errorActions}>
        <FileTextAction label="重试" testID={retryTestID} onPress={onRetry} primary />
        <FileTextAction
          label={details ? '收起详情' : '查看错误详情'}
          testID={`${testID}-details-toggle`}
          onPress={() => setDetails(value => !value)}
        />
      </View>
      {details ? (
        <ScrollView style={styles.errorDetails}>
          <Text
            selectable
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
            testID={`${testID}-details`}
          >
            {message}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

export function FileTextAction({
  label,
  testID,
  onPress,
  primary = false,
}: {
  label: string
  testID: string
  onPress: () => void
  primary?: boolean
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.textAction,
        primary && { backgroundColor: theme.colors.primary },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text
        variant="labelMedium"
        style={{ color: primary ? theme.colors.onPrimary : theme.colors.onSurfaceVariant }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    height: 68,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 12,
  },
  headerSpacer: { width: 44 },
  title: { flex: 1, minWidth: 0 },
  centeredTitle: { alignItems: 'center' },
  titleButton: { minHeight: 44, justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titleText: { fontWeight: '600', flexShrink: 1 },
  headerCapsule: {
    width: 100,
    height: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  glassAction: { width: 44, height: 44, borderRadius: 22 },
  largeGlassAction: { width: 48, height: 48, borderRadius: 24 },
  action: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menu: { borderRadius: 12, paddingVertical: 4 },
  menuItem: { minHeight: 44, borderRadius: 8, marginHorizontal: 4 },
  metadata: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  segments: { flexDirection: 'row', position: 'relative' },
  segmentTrack: { position: 'absolute', top: 6, bottom: 6, left: 0, right: 0, borderRadius: 22 },
  segment: { flex: 1, minWidth: 64, minHeight: 44, paddingHorizontal: 2, paddingVertical: 8 },
  segmentLabel: {
    flex: 1,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  error: { width: '100%', alignItems: 'center', padding: 24, gap: 12 },
  compactError: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  errorIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  centerText: { textAlign: 'center' },
  errorActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  errorDetails: { maxHeight: 160, alignSelf: 'stretch', marginTop: 4 },
  textAction: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
