import Ionicons from '@expo/vector-icons/Ionicons'
import { useIsFocused } from '@react-navigation/native'
import type { GlassColorScheme } from 'expo-glass-effect'
import { useEffect, useMemo, useState } from 'react'
import {
  BackHandler,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller'
import { ActivityIndicator, Portal, Text, useTheme, type MD3Theme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { buildConversationList } from '@/domain/conversationList'
import { DRAWER_HEADER_HEIGHT, drawerBottomOffset, drawerTopPadding } from '@/domain/drawerLayout'
import {
  mobileCreatableDevices,
  mobileProjectCreatableDevices,
  onlineDevicesFirst,
} from '@/domain/deviceOrdering'
import type {
  ConversationItem,
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
} from '@/types/runtime'
import { LiquidGlassButton, LiquidGlassSurface } from './LiquidGlass'
import { WorkbenchSidebar } from './WorkbenchSidebar'

interface ConversationListScreenProps {
  userLabel?: string
  conversations: ConversationItem[]
  devices: DeviceInfo[]
  workspaces: Array<{ projectName: string; workspace: RuntimeDeviceWorkspace }>
  currentAddress: RuntimeTaskAddress | null
  selectedDeviceId: string | null
  allDevicesSelected: boolean
  search: string
  loading: boolean
  refreshing: boolean
  onSearch: (value: string) => void
  onRefresh: () => Promise<void>
  onSelectDevice: (deviceId: string) => void
  onSelectAllDevices: () => void
  onSelectConversation: (item: ConversationItem) => void
  onNewConversation: (workspace?: RuntimeDeviceWorkspace) => void
  onNewProject: () => void
  onSettings: () => void
}

type DrawerItem =
  | {
      key: 'pinned-title' | 'projects-title' | 'tasks-title'
      type: 'section'
      section: DrawerSection
      title: '置顶' | '项目' | '任务'
      expanded: boolean
    }
  | {
      key: string
      type: 'project'
      name: string
      detail: string | null
      workspace: RuntimeDeviceWorkspace | undefined
      expanded: boolean
    }
  | { key: string; type: 'conversation'; conversation: ConversationItem }
  | { key: 'empty'; type: 'empty' }

type DrawerSection = 'pinned' | 'projects' | 'tasks'

const BOTTOM_CONTROL_HEIGHT = 48
const SEARCH_LINE_HEIGHT = 22
const searchVerticalInset = (44 - SEARCH_LINE_HEIGHT) / 2

export function ConversationListScreen(props: ConversationListScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const focused = useIsFocused()
  const keyboardVisible = useKeyboardState(state => state.isVisible)
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors])
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const [actionsVisible, setActionsVisible] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [searchVisible, setSearchVisible] = useState(Boolean(props.search))
  const [showAllDevices, setShowAllDevices] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<DrawerSection>>(
    () => new Set(['pinned'])
  )
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
  const creatableDeviceIds = new Set(
    mobileCreatableDevices(props.devices).map(device => device.device_id)
  )
  const canCreate = [...creatableDeviceIds].some(
    deviceId => props.allDevicesSelected || deviceId === props.selectedDeviceId
  )
  const canCreateProject = mobileProjectCreatableDevices(props.devices).some(
    device => props.allDevicesSelected || device.device_id === props.selectedDeviceId
  )
  const selectedDeviceId = props.allDevicesSelected
    ? null
    : (onlineDevices.find(device => device.device_id === props.selectedDeviceId)?.device_id ??
      onlineDevices[0]?.device_id ??
      null)
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
    ({ projectName, workspace }) =>
      workspace.available &&
      onlineDeviceIds.has(workspace.deviceId) &&
      (!selectedDeviceId || workspace.deviceId === selectedDeviceId) &&
      (!query ||
        `${projectName} ${workspace.label ?? ''} ${workspace.deviceName}`
          .toLocaleLowerCase()
          .includes(query) ||
        filteredConversations.some(
          item =>
            item.address.deviceId === workspace.deviceId &&
            item.sourceWorkspacePath === workspace.workspacePath
        ))
  )

  const drawerItems = useMemo<DrawerItem[]>(() => {
    const projectsExpanded = !collapsedSections.has('projects')
    const tasksExpanded = !collapsedSections.has('tasks')
    const items: DrawerItem[] = [
      {
        key: 'projects-title',
        type: 'section',
        section: 'projects',
        title: '项目',
        expanded: projectsExpanded,
      },
    ]
    const groups = buildConversationList(filteredConversations, visibleWorkspaces)
    const pinnedExpanded = !collapsedSections.has('pinned')
    items.unshift({
      key: 'pinned-title',
      type: 'section',
      section: 'pinned',
      title: '置顶',
      expanded: pinnedExpanded,
    })
    if (pinnedExpanded) {
      items.splice(
        1,
        0,
        ...groups.pinned.map(conversation => ({
          key: `pinned:${conversation.address.deviceId}:${conversation.address.taskId}`,
          type: 'conversation' as const,
          conversation,
        }))
      )
    }
    if (projectsExpanded) {
      for (const group of groups.projects) {
        const expanded = !collapsedProjects.has(group.key)
        items.push({
          key: group.key,
          type: 'project',
          name: group.name,
          detail: group.detail,
          workspace: group.workspace,
          expanded,
        })
        if (!expanded) continue
        for (const conversation of group.conversations) {
          items.push({
            key: `conversation:${conversation.address.deviceId}:${conversation.address.taskId}`,
            type: 'conversation',
            conversation,
          })
        }
      }
    }

    items.push({
      key: 'tasks-title',
      type: 'section',
      section: 'tasks',
      title: '任务',
      expanded: tasksExpanded,
    })
    if (tasksExpanded) {
      for (const conversation of groups.standalone) {
        items.push({
          key: `conversation:${conversation.address.deviceId}:${conversation.address.taskId}`,
          type: 'conversation',
          conversation,
        })
      }
    }
    if (
      groups.projects.length === 0 &&
      groups.standalone.length === 0 &&
      groups.pinned.length === 0
    ) {
      items.push({ key: 'empty', type: 'empty' })
    }

    return items
  }, [collapsedProjects, collapsedSections, filteredConversations, visibleWorkspaces])

  const toggleSection = (section: DrawerSection) => {
    setCollapsedSections(current => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const toggleProject = (projectName: string) => {
    setCollapsedProjects(current => {
      const next = new Set(current)
      if (next.has(projectName)) next.delete(projectName)
      else next.add(projectName)
      return next
    })
  }

  useEffect(() => {
    if (!focused) {
      setActionsVisible(false)
      setSidebarVisible(false)
    }
  }, [focused])

  useEffect(() => {
    if (Platform.OS !== 'android' || !focused || (!actionsVisible && !searchVisible)) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (actionsVisible) setActionsVisible(false)
      else {
        setSearchVisible(false)
        props.onSearch('')
        Keyboard.dismiss()
      }
      return true
    })
    return () => subscription.remove()
  }, [actionsVisible, focused, props.onSearch, searchVisible])

  const closeSearch = () => {
    setSearchVisible(false)
    props.onSearch('')
    Keyboard.dismiss()
  }

  const deviceStrip = (
    <FlatList
      contentContainerStyle={styles.deviceStrip}
      data={displayedDevices}
      horizontal
      keyboardShouldPersistTaps="handled"
      keyExtractor={device => device.device_id}
      ListHeaderComponent={
        <Pressable
          accessibilityLabel="显示所有设备任务"
          accessibilityRole="button"
          accessibilityState={{ selected: props.allDevicesSelected }}
          onPress={props.onSelectAllDevices}
          style={[styles.allDevicePill, props.allDevicesSelected && styles.selectedDevicePill]}
          testID="device-option-all"
        >
          <Text style={[styles.deviceText, props.allDevicesSelected && styles.deviceTextSelected]}>
            全部
          </Text>
        </Pressable>
      }
      renderItem={({ item: device }) => {
        const selected = device.device_id === selectedDeviceId
        const online = device.status !== 'offline'
        return (
          <Pressable
            accessibilityLabel={device.name}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: !online }}
            disabled={!online}
            onPress={() => props.onSelectDevice(device.device_id)}
            style={[styles.devicePill, selected && styles.selectedDevicePill]}
            testID={`device-option-${device.device_id}`}
          >
            <View style={[styles.statusDot, online ? styles.onlineDot : styles.offlineDot]} />
            <Ionicons
              color={selected ? theme.colors.onBackground : theme.colors.onSurfaceVariant}
              name="laptop-outline"
              size={19}
            />
            <Text
              numberOfLines={1}
              style={[styles.deviceText, selected && styles.deviceTextSelected]}
            >
              {device.name}
            </Text>
          </Pressable>
        )
      }}
      showsHorizontalScrollIndicator={false}
      style={styles.deviceScroller}
      testID="device-carousel"
    />
  )

  return (
    <KeyboardAvoidingView
      automaticOffset
      behavior="height"
      enabled={focused}
      style={[styles.panel, { paddingTop: drawerTopPadding(insets.top) }]}
      testID="conversation-list-keyboard"
    >
      <View style={styles.header}>
        {searchVisible ? (
          <LiquidGlassSurface
            colorScheme={glassColorScheme}
            fallbackStyle={styles.glassFallback}
            style={styles.searchGlass}
          >
            <View style={styles.searchBox}>
              <Ionicons color={theme.colors.onSurfaceVariant} name="search-outline" size={25} />
              <TextInput
                accessibilityLabel="搜索聊天记录"
                autoFocus
                onChangeText={props.onSearch}
                placeholder="搜索聊天"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                returnKeyType="search"
                style={styles.searchInput}
                testID="conversation-search"
                value={props.search}
              />
            </View>
          </LiquidGlassSurface>
        ) : (
          <>
            <LiquidGlassButton
              accessibilityLabel="打开侧边栏"
              colorScheme={glassColorScheme}
              contentStyle={styles.roundButton}
              fallbackStyle={styles.glassFallback}
              onPress={() => setSidebarVisible(true)}
              style={styles.roundGlass}
              testID="drawer-close"
            >
              <View style={styles.menuGlyph}>
                <View style={[styles.menuGlyphLine, styles.menuGlyphLineLong]} />
                <View style={styles.menuGlyphLine} />
              </View>
            </LiquidGlassButton>
            <Pressable
              accessibilityLabel="Wework 更多选项"
              accessibilityRole="button"
              accessibilityState={{ expanded: actionsVisible }}
              onPress={() => setActionsVisible(true)}
              style={styles.titleButton}
              testID="drawer-actions"
            >
              <Text style={styles.headerTitle}>Wework</Text>
              <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-down" size={14} />
            </Pressable>
          </>
        )}
        <LiquidGlassButton
          accessibilityLabel={searchVisible ? '关闭搜索' : '搜索聊天记录'}
          colorScheme={glassColorScheme}
          contentStyle={styles.roundButton}
          fallbackStyle={styles.glassFallback}
          onPress={searchVisible ? closeSearch : () => setSearchVisible(true)}
          style={styles.roundGlass}
          testID="drawer-search-toggle"
        >
          <Ionicons
            color={theme.colors.onBackground}
            name={searchVisible ? 'close' : 'search-outline'}
            size={27}
          />
        </LiquidGlassButton>
      </View>

      <WorkbenchSidebar
        onDismiss={() => setSidebarVisible(false)}
        onSettings={props.onSettings}
        userLabel={props.userLabel ?? ''}
        visible={focused && sidebarVisible}
      />

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
                  disabled={!canCreateProject}
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
                <DrawerAction
                  icon={showAllDevices ? 'eye-off-outline' : 'eye-outline'}
                  label={showAllDevices ? '仅显示在线设备' : '显示全部设备'}
                  onPress={() => {
                    setActionsVisible(false)
                    setShowAllDevices(current => !current)
                  }}
                  testID="drawer-toggle-offline-devices"
                />
              </LiquidGlassSurface>
            </Pressable>
          </Pressable>
        </Portal>
      ) : null}

      <FlatList
        contentContainerStyle={styles.list}
        data={props.loading ? [] : drawerItems}
        ListHeaderComponent={deviceStrip}
        ListEmptyComponent={props.loading ? <ActivityIndicator style={styles.loader} /> : null}
        keyExtractor={item => item.key}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => void props.onRefresh()}
            refreshing={props.refreshing}
            testID="conversation-list-refresh"
            tintColor={theme.colors.onSurfaceVariant}
          />
        }
        renderItem={({ item }) => {
          if (item.type === 'section') {
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: item.expanded }}
                onPress={() => toggleSection(item.section)}
                style={({ pressed }) => [
                  styles.sectionHeader,
                  item.section === 'tasks' && styles.tasksSectionHeader,
                  pressed && styles.rowPressed,
                ]}
                testID={`section-${item.section}-toggle`}
              >
                <Text style={styles.sectionTitle} variant="titleMedium">
                  {item.title}
                </Text>
                <Ionicons
                  color={theme.colors.onSurfaceVariant}
                  name={item.expanded ? 'chevron-down' : 'chevron-forward'}
                  size={18}
                />
              </Pressable>
            )
          }
          if (item.type === 'project') {
            const canCreateWorkspace = Boolean(
              item.workspace && creatableDeviceIds.has(item.workspace.deviceId)
            )
            return (
              <View style={styles.projectRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => toggleProject(item.key)}
                  style={({ pressed }) => [styles.projectMain, pressed && styles.rowPressed]}
                  testID={`project-${item.name}`}
                >
                  <Ionicons
                    color={theme.colors.onBackground}
                    name={item.expanded ? 'folder-open-outline' : 'folder-outline'}
                    size={23}
                  />
                  <View style={styles.projectLabel}>
                    <Text numberOfLines={1} style={styles.projectName} variant="titleMedium">
                      {item.name}
                    </Text>
                    {item.detail ? (
                      <Text numberOfLines={1} style={styles.projectDetail}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
                <Pressable
                  accessibilityLabel={`在 ${item.name} 中新建聊天`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canCreateWorkspace }}
                  disabled={!canCreateWorkspace}
                  onPress={() => props.onNewConversation(item.workspace)}
                  style={styles.projectComposeGlass}
                  testID={`workspace-new-${item.workspace?.deviceId ?? 'none'}-${item.workspace?.workspacePath ?? item.name}`}
                >
                  <Ionicons
                    color={
                      canCreateWorkspace ? theme.colors.onSurfaceVariant : theme.colors.outline
                    }
                    name="create-outline"
                    size={22}
                  />
                </Pressable>
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
                  item.conversation.projectName && styles.projectTextRow,
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
                {onlineDeviceIds.size ? '当前范围内还没有会话' : '请先在电脑端启动 Wework executor'}
              </Text>
            </View>
          )
        }}
        showsVerticalScrollIndicator={false}
        testID="conversation-list"
      />

      {!searchVisible ? (
        <View
          style={[
            styles.bottomDock,
            { bottom: drawerBottomOffset(insets.bottom, keyboardVisible) },
          ]}
        >
          <LiquidGlassButton
            accessibilityLabel="新聊天"
            colorScheme={glassColorScheme}
            contentStyle={styles.askContent}
            disabled={!canCreate}
            fallbackStyle={styles.glassFallback}
            onPress={() => props.onNewConversation()}
            style={styles.askGlass}
            testID="drawer-new-conversation"
          >
            <Ionicons
              color={canCreate ? theme.colors.onBackground : theme.colors.onSurfaceVariant}
              name="add"
              size={26}
            />
            <Text style={styles.askPlaceholder}>向 Wework 提问</Text>
          </LiquidGlassButton>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}

function DrawerAction({
  disabled = false,
  icon,
  label,
  onPress,
  showAddBadge = false,
  testID,
}: {
  disabled?: boolean
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  showAddBadge?: boolean
  testID: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      disabled={disabled}
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        pressed && styles.actionRowPressed,
        disabled && { opacity: 0.4 },
      ]}
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
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    titleButton: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    headerTitle: { fontSize: 17, fontWeight: '600', color: colors.onBackground },
    glassFallback: { backgroundColor: colors.surface, borderColor: colors.outlineVariant },
    roundGlass: { width: 44, height: 44, borderRadius: 22 },
    roundButton: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 22,
    },
    menuGlyph: { width: 22, gap: 7, alignItems: 'flex-start' },
    menuGlyphLine: { width: 14, height: 2, borderRadius: 2, backgroundColor: colors.onBackground },
    menuGlyphLineLong: { width: 22 },
    actionsBackdrop: { position: 'absolute', inset: 0 },
    actionsPositioner: { position: 'absolute', alignSelf: 'center', width: 240 },
    actionsGlass: { padding: 8, borderRadius: 28, overflow: 'hidden' },
    deviceScroller: { flexGrow: 0, height: 60 },
    deviceStrip: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 6,
      gap: 8,
      alignItems: 'center',
    },
    allDevicePill: {
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    devicePill: {
      maxWidth: 280,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    selectedDevicePill: { backgroundColor: colors.surfaceVariant },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    onlineDot: { backgroundColor: '#20be8b' },
    offlineDot: { backgroundColor: '#ff535f' },
    deviceText: { flexShrink: 1, color: colors.onSurfaceVariant, fontSize: 17 },
    deviceTextSelected: { color: colors.onBackground, fontWeight: '500' },
    loader: { flex: 1 },
    list: { paddingTop: 4, paddingBottom: 104, flexGrow: 1 },
    sectionHeader: {
      minHeight: 50,
      marginHorizontal: 16,
      paddingHorizontal: 4,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    tasksSectionHeader: { marginTop: 20 },
    sectionTitle: { color: colors.onBackground, fontSize: 16, fontWeight: '600' },
    projectRow: {
      minHeight: 48,
      paddingLeft: 20,
      paddingRight: 12,
      flexDirection: 'row',
      alignItems: 'center',
    },
    projectMain: {
      minHeight: 48,
      flex: 1,
      minWidth: 0,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    projectLabel: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    projectName: { flexShrink: 1, color: colors.onBackground, fontSize: 17, fontWeight: '500' },
    projectDetail: { flexShrink: 2, color: colors.onSurfaceVariant, fontSize: 17 },
    projectComposeGlass: {
      width: 44,
      height: 44,
      marginLeft: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textRow: { minHeight: 48, marginHorizontal: 20, borderRadius: 12, overflow: 'hidden' },
    projectTextRow: { marginLeft: 52 },
    textRowContent: {
      minHeight: 48,
      width: '100%',
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    rowSelected: { backgroundColor: colors.surfaceVariant },
    rowPressed: { backgroundColor: colors.surfaceVariant },
    rowTitle: { flex: 1, color: colors.onBackground, fontSize: 17, fontWeight: '400' },
    empty: {
      flex: 1,
      minHeight: 220,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: 32,
    },
    muted: { color: colors.onSurfaceVariant, textAlign: 'center' },
    bottomDock: { position: 'absolute', left: 36, right: 36 },
    askGlass: { height: BOTTOM_CONTROL_HEIGHT, borderRadius: BOTTOM_CONTROL_HEIGHT / 2 },
    askContent: {
      minHeight: BOTTOM_CONTROL_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
    },
    askPlaceholder: { color: colors.onSurfaceVariant, fontSize: 17, flex: 1 },
    searchGlass: { height: 44, borderRadius: 22, flex: 1 },
    searchBox: {
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
    },
    searchInput: {
      flex: 1,
      color: colors.onBackground,
      fontSize: 17,
      lineHeight: SEARCH_LINE_HEIGHT,
      paddingVertical: searchVerticalInset,
      paddingHorizontal: 0,
      includeFontPadding: false,
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
