import Ionicons from '@expo/vector-icons/Ionicons'
import { useIsFocused } from '@react-navigation/native'
import type { GlassColorScheme } from 'expo-glass-effect'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, Platform, Pressable, StyleSheet, View } from 'react-native'
import { ActivityIndicator, Portal, Text, useTheme, type MD3Theme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { DRAWER_HEADER_HEIGHT, drawerBottomOffset, drawerTopPadding } from '@/domain/drawerLayout'
import { onlineDevicesFirst } from '@/domain/deviceOrdering'
import type {
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
} from '@/types/runtime'
import {
  LiquidGlassButton,
  LiquidGlassGroup,
  LiquidGlassSurface,
  liquidGlassAccentBorder,
  liquidGlassAccentTint,
} from './LiquidGlass'
import { KeyboardSafeTextInput, KeyboardSafeView, useKeyboardVisible } from './KeyboardSafeInput'

interface ConversationListScreenProps {
  conversations: ConversationItem[]
  devices: DeviceInfo[]
  workspaces: Array<{ projectName: string; workspace: RuntimeDeviceWorkspace }>
  currentAddress: RuntimeTaskAddress | null
  selectedDeviceId: string | null
  search: string
  loading: boolean
  onSearch: (value: string) => void
  onSelectDevice: (deviceId: string) => void
  onSelectConversation: (item: ConversationItem) => void
  onNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  onNewProject: () => void
  onSettings: () => void
  onOpenCurrentConversation: () => void
}

type DrawerItem =
  | { key: 'projects-title'; type: 'projects-title' }
  | {
      key: string
      type: 'project'
      name: string
      workspace: RuntimeDeviceWorkspace | undefined
      expanded: boolean
    }
  | { key: string; type: 'conversation'; conversation: ConversationItem }
  | { key: 'empty'; type: 'empty' }

const BOTTOM_CONTROL_HEIGHT = 52
const SEARCH_LINE_HEIGHT = 22
const searchVerticalInset = (BOTTOM_CONTROL_HEIGHT - SEARCH_LINE_HEIGHT) / 2
const searchTextOpticalOffset = Platform.OS === 'ios' ? 2 : 0

export function ConversationListScreen(props: ConversationListScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const keyboardVisible = useKeyboardVisible()
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors])
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const [actionsVisible, setActionsVisible] = useState(false)
  const [showAllDevices, setShowAllDevices] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const onlineDeviceIds = useMemo(
    () =>
      new Set(
        props.devices.filter(device => device.status !== 'offline').map(device => device.device_id)
      ),
    [props.devices]
  )
  const onlineDevices = props.devices.filter(device => onlineDeviceIds.has(device.device_id))
  const displayedDevices = showAllDevices ? onlineDevicesFirst(props.devices) : onlineDevices
  const selectedDeviceId =
    onlineDevices.find(device => device.device_id === props.selectedDeviceId)?.device_id ??
    onlineDevices[0]?.device_id ??
    null
  const query = props.search.trim().toLocaleLowerCase()

  const filteredConversations = props.conversations.filter(item => {
    if (!onlineDeviceIds.has(item.address.deviceId)) return false
    if (selectedDeviceId && item.address.deviceId !== selectedDeviceId) return false
    if (!query) return true
    return `${item.title} ${item.projectName ?? ''} ${item.deviceName}`
      .toLocaleLowerCase()
      .includes(query)
  })
  const visibleWorkspaces = props.workspaces.filter(
    ({ workspace }) =>
      workspace.available &&
      onlineDeviceIds.has(workspace.deviceId) &&
      (!selectedDeviceId || workspace.deviceId === selectedDeviceId)
  )

  const drawerItems = useMemo<DrawerItem[]>(() => {
    const items: DrawerItem[] = [{ key: 'projects-title', type: 'projects-title' }]
    const projectNames = new Set<string>()
    visibleWorkspaces.forEach(({ projectName }) => projectNames.add(projectName))
    filteredConversations.forEach(item => {
      if (item.projectName) projectNames.add(item.projectName)
    })

    for (const projectName of projectNames) {
      const workspace = visibleWorkspaces.find(item => item.projectName === projectName)?.workspace
      const expanded = !collapsedProjects.has(projectName)
      items.push({
        key: `project:${projectName}`,
        type: 'project',
        name: projectName,
        workspace,
        expanded,
      })
      if (!expanded) continue
      for (const conversation of filteredConversations.filter(
        item => item.projectName === projectName
      )) {
        items.push({
          key: `conversation:${conversation.address.deviceId}:${conversation.address.taskId}`,
          type: 'conversation',
          conversation,
        })
      }
    }

    const standaloneConversations = filteredConversations.filter(item => !item.projectName)
    if (projectNames.size === 0 || standaloneConversations.length > 0) {
      for (const conversation of standaloneConversations) {
        items.push({
          key: `conversation:${conversation.address.deviceId}:${conversation.address.taskId}`,
          type: 'conversation',
          conversation,
        })
      }
    }

    if (items.length === 1) items.push({ key: 'empty', type: 'empty' })
    return items
  }, [collapsedProjects, filteredConversations, visibleWorkspaces])

  const toggleProject = (projectName: string) => {
    setCollapsedProjects(current => {
      const next = new Set(current)
      if (next.has(projectName)) next.delete(projectName)
      else next.add(projectName)
      return next
    })
  }

  useEffect(() => {
    if (!focused) setActionsVisible(false)
  }, [focused])

  const actionsAnchor = (
    <LiquidGlassButton
      accessibilityLabel="更多"
      colorScheme={glassColorScheme}
      contentStyle={styles.roundButton}
      fallbackStyle={styles.glassFallback}
      onPress={() => setActionsVisible(true)}
      style={styles.roundGlass}
      testID="drawer-actions"
    >
      <Ionicons color={theme.colors.onBackground} name="ellipsis-horizontal" size={26} />
    </LiquidGlassButton>
  )

  return (
    <KeyboardSafeView style={[styles.panel, { paddingTop: drawerTopPadding(insets.top) }]}>
      <View style={styles.header}>
        <LiquidGlassButton
          accessibilityLabel="打开当前会话"
          colorScheme={glassColorScheme}
          contentStyle={styles.roundButton}
          fallbackStyle={styles.glassFallback}
          disabled={!props.currentAddress}
          onPress={props.onOpenCurrentConversation}
          style={styles.roundGlass}
          testID="drawer-close"
        >
          <View style={styles.menuGlyph}>
            <View style={[styles.menuGlyphLine, styles.menuGlyphLineLong]} />
            <View style={styles.menuGlyphLine} />
          </View>
        </LiquidGlassButton>
        <Text style={styles.headerTitle} variant="titleMedium">
          远程
        </Text>
        {actionsAnchor}
      </View>

      {focused && actionsVisible ? (
        <Portal>
          <Pressable
            accessibilityLabel="关闭更多菜单"
            accessibilityRole="button"
            onPress={() => setActionsVisible(false)}
            style={styles.actionsBackdrop}
            testID="drawer-actions-backdrop"
          >
            <Pressable
              accessibilityViewIsModal
              onPress={event => event.stopPropagation()}
              style={[
                styles.actionsPositioner,
                { top: drawerTopPadding(insets.top) + DRAWER_HEADER_HEIGHT - 4 },
              ]}
              testID="drawer-actions-menu"
            >
              <LiquidGlassSurface
                colorScheme={glassColorScheme}
                fallbackStyle={styles.glassFallback}
                glassEffectStyle="regular"
                isInteractive
                style={styles.actionsGlass}
              >
                <DrawerAction
                  icon="folder-outline"
                  label="新建项目"
                  onPress={() => {
                    setActionsVisible(false)
                    props.onNewProject()
                  }}
                  showAddBadge
                  testID="drawer-new-project"
                />
                <DrawerAction
                  icon="settings-outline"
                  label="设置"
                  onPress={() => {
                    setActionsVisible(false)
                    props.onSettings()
                  }}
                  testID="drawer-settings"
                />
              </LiquidGlassSurface>
            </Pressable>
          </Pressable>
        </Portal>
      ) : null}

      <FlatList
        contentContainerStyle={styles.deviceStrip}
        data={displayedDevices}
        horizontal
        keyExtractor={device => device.device_id}
        ListHeaderComponent={
          <LiquidGlassButton
            accessibilityLabel={showAllDevices ? '仅显示在线设备' : '显示全部设备'}
            colorScheme={glassColorScheme}
            contentStyle={styles.allDevicePill}
            fallbackStyle={styles.glassFallback}
            onPress={() => setShowAllDevices(current => !current)}
            style={styles.deviceGlass}
            testID="device-option-all"
          >
            <Text style={styles.deviceText}>{showAllDevices ? '仅在线' : '全部'}</Text>
          </LiquidGlassButton>
        }
        renderItem={({ item: device }) => {
          const selected = device.device_id === selectedDeviceId
          const online = device.status !== 'offline'
          return (
            <LiquidGlassButton
              accessibilityLabel={device.name}
              colorScheme={glassColorScheme}
              contentStyle={styles.devicePill}
              disabled={!online}
              fallbackStyle={selected ? styles.selectedGlassFallback : styles.glassFallback}
              glassEffectStyle={selected ? 'clear' : 'regular'}
              onPress={() => props.onSelectDevice(device.device_id)}
              style={styles.deviceGlass}
              testID={`device-option-${device.device_id}`}
              tintColor={selected ? theme.colors.primary : undefined}
            >
              <View style={[styles.statusDot, online ? styles.onlineDot : styles.offlineDot]} />
              <Ionicons
                color={selected ? theme.colors.onPrimary : theme.colors.onBackground}
                name="laptop-outline"
                size={22}
              />
              <Text
                numberOfLines={1}
                style={[styles.deviceText, selected && styles.deviceTextSelected]}
              >
                {device.name}
              </Text>
            </LiquidGlassButton>
          )
        }}
        showsHorizontalScrollIndicator={false}
        style={styles.deviceScroller}
        testID="device-carousel"
      />

      {props.loading ? (
        <ActivityIndicator style={styles.loader} />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={drawerItems}
          keyExtractor={item => item.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            if (item.type === 'projects-title') {
              return (
                <Text style={styles.sectionTitle} variant="titleMedium">
                  项目
                </Text>
              )
            }
            if (item.type === 'project') {
              return (
                <View style={styles.projectRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => toggleProject(item.name)}
                    style={({ pressed }) => [styles.projectMain, pressed && styles.rowPressed]}
                    testID={`project-${item.name}`}
                  >
                    <Ionicons
                      color={theme.colors.onBackground}
                      name={item.expanded ? 'folder-open-outline' : 'folder-outline'}
                      size={27}
                    />
                    <Text numberOfLines={1} style={styles.projectName} variant="titleMedium">
                      {item.name}
                    </Text>
                    <Ionicons
                      color={theme.colors.onSurfaceVariant}
                      name={item.expanded ? 'chevron-down' : 'chevron-forward'}
                      size={18}
                    />
                  </Pressable>
                  <LiquidGlassButton
                    accessibilityLabel={`在 ${item.name} 中新建聊天`}
                    colorScheme={glassColorScheme}
                    contentStyle={styles.projectCompose}
                    disabled={!item.workspace}
                    fallbackStyle={styles.glassFallback}
                    onPress={() => props.onNewConversation(item.workspace)}
                    style={styles.projectComposeGlass}
                    testID={`workspace-new-${item.workspace?.deviceId ?? 'none'}-${item.workspace?.workspacePath ?? item.name}`}
                  >
                    <Ionicons
                      color={
                        item.workspace ? theme.colors.onBackground : theme.colors.onSurfaceVariant
                      }
                      name="create-outline"
                      size={25}
                    />
                  </LiquidGlassButton>
                </View>
              )
            }
            if (item.type === 'conversation') {
              const selected =
                props.currentAddress?.deviceId === item.conversation.address.deviceId &&
                props.currentAddress.taskId === item.conversation.address.taskId
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => props.onSelectConversation(item.conversation)}
                  style={({ pressed }) => [
                    styles.textRow,
                    selected && styles.rowSelected,
                    pressed && styles.rowPressed,
                  ]}
                  testID={`conversation-${item.conversation.address.taskId}`}
                >
                  <View style={styles.textRowContent}>
                    <Text numberOfLines={1} style={styles.rowTitle} variant="titleMedium">
                      {item.conversation.title}
                    </Text>
                    {item.conversation.running ? (
                      <ActivityIndicator color={theme.colors.onSurfaceVariant} size={22} />
                    ) : null}
                  </View>
                </Pressable>
              )
            }
            return (
              <View style={styles.empty}>
                <Text style={styles.rowTitle} variant="titleMedium">
                  {onlineDeviceIds.size ? '暂无会话' : '暂无在线 Executor'}
                </Text>
                <Text style={styles.muted} variant="bodyMedium">
                  {onlineDeviceIds.size
                    ? '当前范围内还没有会话'
                    : '请先在电脑端启动 Wework executor'}
                </Text>
              </View>
            )
          }}
          showsVerticalScrollIndicator={false}
          testID="conversation-list"
        />
      )}

      <LiquidGlassGroup
        spacing={8}
        style={[styles.bottomDock, { bottom: drawerBottomOffset(insets.bottom, keyboardVisible) }]}
      >
        <LiquidGlassSurface
          colorScheme={glassColorScheme}
          fallbackStyle={styles.glassFallback}
          style={styles.searchGlass}
        >
          <View style={styles.searchBox}>
            <Ionicons color={theme.colors.onSurfaceVariant} name="search-outline" size={21} />
            <KeyboardSafeTextInput
              accessibilityLabel="搜索聊天记录"
              onChangeText={props.onSearch}
              placeholder="搜索聊天记录"
              placeholderTextColor={theme.colors.onSurfaceVariant}
              style={styles.searchInput}
              testID="conversation-search"
              value={props.search}
            />
          </View>
        </LiquidGlassSurface>
        <LiquidGlassButton
          accessibilityLabel="新聊天"
          colorScheme={glassColorScheme}
          contentStyle={styles.roundButton}
          disabled={onlineDeviceIds.size === 0}
          fallbackStyle={onlineDeviceIds.size ? styles.blueGlassFallback : styles.glassFallback}
          glassEffectStyle="regular"
          onPress={() => props.onNewConversation()}
          style={styles.bottomRoundGlass}
          testID="drawer-new-conversation"
          tintColor={onlineDeviceIds.size ? liquidGlassAccentTint : undefined}
        >
          <Ionicons
            color={onlineDeviceIds.size ? '#ffffff' : theme.colors.onSurfaceVariant}
            name="create-outline"
            size={24}
          />
        </LiquidGlassButton>
      </LiquidGlassGroup>
    </KeyboardSafeView>
  )
}

function DrawerAction({
  icon,
  label,
  onPress,
  showAddBadge = false,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  showAddBadge?: boolean
  testID: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
      testID={testID}
    >
      <View style={styles.actionIconCircle}>
        <Ionicons color={theme.colors.onSurface} name={icon} size={22} />
        {showAddBadge ? (
          <View style={[styles.actionAddBadge, { backgroundColor: theme.colors.primary }]}>
            <Ionicons color={theme.colors.onPrimary} name="add" size={13} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.actionLabel} variant="titleMedium">
        {label}
      </Text>
    </Pressable>
  )
}

function createStyles(colors: MD3Theme['colors']) {
  return StyleSheet.create({
    panel: { flex: 1, backgroundColor: colors.background },
    header: {
      height: DRAWER_HEADER_HEIGHT,
      paddingHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerTitle: { fontWeight: '600', color: colors.onBackground },
    glassFallback: {
      backgroundColor: colors.elevation.level2,
      borderColor: colors.outlineVariant,
    },
    selectedGlassFallback: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    blueGlassFallback: {
      backgroundColor: liquidGlassAccentTint,
      borderColor: liquidGlassAccentBorder,
    },
    roundGlass: {
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    roundButton: {
      width: '100%',
      height: '100%',
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuGlyph: { width: 26, gap: 8, alignItems: 'flex-start' },
    menuGlyphLine: {
      width: 17,
      height: 3,
      borderRadius: 2,
      backgroundColor: colors.onBackground,
    },
    menuGlyphLineLong: { width: 26 },
    actionsBackdrop: { position: 'absolute', inset: 0 },
    actionsPositioner: { position: 'absolute', right: 20, width: 196 },
    actionsGlass: {
      padding: 8,
      borderRadius: 28,
      overflow: 'hidden',
    },
    deviceScroller: { flexGrow: 0, height: 52 },
    deviceStrip: {
      paddingHorizontal: 24,
      paddingBottom: 8,
      gap: 8,
      alignItems: 'center',
    },
    deviceGlass: {
      height: 36,
      borderRadius: 18,
    },
    allDevicePill: {
      height: 36,
      paddingHorizontal: 18,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    devicePill: {
      maxWidth: 220,
      height: 36,
      paddingHorizontal: 14,
      borderRadius: 18,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    onlineDot: { backgroundColor: '#20c77a' },
    offlineDot: { backgroundColor: '#ff7d87' },
    deviceText: { maxWidth: 160, flexShrink: 1, color: colors.onBackground, fontSize: 15 },
    deviceTextSelected: { color: colors.onPrimary },
    loader: { flex: 1 },
    list: { paddingTop: 12, paddingBottom: 104, flexGrow: 1 },
    sectionTitle: {
      color: colors.onBackground,
      fontWeight: '600',
      marginHorizontal: 24,
      marginBottom: 10,
    },
    projectRow: {
      minHeight: 52,
      marginBottom: 6,
      paddingLeft: 24,
      paddingRight: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    projectMain: {
      minHeight: 52,
      flex: 1,
      minWidth: 0,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    projectName: { flex: 1, color: colors.onBackground, fontWeight: '400' },
    projectComposeGlass: {
      width: 44,
      height: 44,
      marginLeft: 8,
      borderRadius: 22,
    },
    projectCompose: {
      width: '100%',
      height: '100%',
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textRow: {
      minHeight: 52,
      marginHorizontal: 24,
      borderRadius: 12,
      overflow: 'hidden',
    },
    textRowContent: {
      minHeight: 52,
      width: '100%',
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    rowSelected: { backgroundColor: colors.elevation.level1 },
    rowPressed: { backgroundColor: colors.elevation.level1 },
    rowTitle: { flex: 1, color: colors.onBackground, fontWeight: '400' },
    empty: {
      flex: 1,
      minHeight: 220,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: 32,
    },
    muted: { color: colors.onSurfaceVariant, textAlign: 'center' },
    bottomDock: {
      position: 'absolute',
      left: 8,
      right: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    searchGlass: {
      height: BOTTOM_CONTROL_HEIGHT,
      flex: 1,
      minWidth: 0,
      borderRadius: 26,
    },
    searchBox: {
      width: '100%',
      height: '100%',
      paddingHorizontal: 14,
      borderRadius: 26,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      height: BOTTOM_CONTROL_HEIGHT,
      paddingTop: searchVerticalInset - searchTextOpticalOffset,
      paddingBottom: searchVerticalInset + searchTextOpticalOffset,
      color: colors.onBackground,
      fontSize: 16,
      lineHeight: SEARCH_LINE_HEIGHT,
    },
    bottomRoundGlass: {
      width: BOTTOM_CONTROL_HEIGHT,
      height: BOTTOM_CONTROL_HEIGHT,
      borderRadius: 26,
    },
  })
}

const styles = StyleSheet.create({
  actionRow: {
    height: 58,
    paddingHorizontal: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionRowPressed: { backgroundColor: 'rgba(128,128,128,0.16)' },
  actionIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.18)',
  },
  actionAddBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { flex: 1, fontSize: 17, fontWeight: '500' },
})
