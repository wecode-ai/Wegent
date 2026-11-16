import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  findNodeHandle,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { ActivityIndicator, Text, useTheme, type MD3Theme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  modelLabel,
  modelSupportsSpeed,
  reasoningEfforts,
  reasoningLabel,
  resolvedReasoningEffort,
  selectableModels,
  speedLabel,
  SPEED_OPTIONS,
} from '@/domain/modelSelection'
import { modelControlAppearance } from '@/domain/modelControlPresentation'
import type { ModelMenuAnchor } from '@/domain/modelPopoverLayout'
import type { ModelOptions, UnifiedModel } from '@/types/runtime'
import { ModelControlSurface } from './ModelControlSurface'
import { ModelOptionPopover } from './ModelOptionPopover'
import {
  groupModelsByFamily,
  isSameModelSelection,
  modelSelectionKey,
} from '../../../packages/collaboration/src/controls/model-ui'

interface ModelPickerScreenProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedOptions: ModelOptions
  loading: boolean
  error: string | null
  onLoadModels: (force?: boolean) => Promise<void>
  onDismiss: () => void
  onSelect: (model: UnifiedModel, options?: ModelOptions) => void
}

type AdvancedMenu = 'model' | 'reasoning' | 'speed'

export function ModelPickerScreen(props: ModelPickerScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const [viewport, setViewport] = useState({ width: window.width, height: window.height })
  const appearance = useMemo(() => modelControlAppearance(theme.dark), [theme.dark])
  const styles = useMemo(() => createStyles(theme.colors, theme.dark), [theme.colors, theme.dark])
  const overlayRef = useRef<View>(null)
  const anchorRef = useRef<View | null>(null)
  const [menu, setMenu] = useState<{ kind: AdvancedMenu; anchor: ModelMenuAnchor } | null>(null)
  useEffect(() => {
    void props.onLoadModels()
  }, [props.onLoadModels])
  const sections = useMemo(() => {
    const models = selectableModels(props.models)
    return [
      { label: '设备模型', models: models.filter(model => model.provider === 'local') },
      { label: '云端模型', models: models.filter(model => model.provider !== 'local') },
    ]
      .map(section => ({ ...section, groups: groupModelsByFamily(section.models) }))
      .filter(section => section.groups.length)
  }, [props.models])
  const efforts = props.selectedModel ? reasoningEfforts(props.selectedModel) : []
  const selectedEffort = resolvedReasoningEffort(
    props.selectedModel,
    props.selectedOptions.reasoning
  )
  const speedSupported = modelSupportsSpeed(props.selectedModel)

  const closeMenu = useCallback(() => {
    setMenu(null)
    const handle = findNodeHandle(anchorRef.current)
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle)
  }, [])
  const openMenu = (kind: AdvancedMenu, target: View) => {
    const overlay = overlayRef.current
    if (!overlay) return
    anchorRef.current = target
    target.measureLayout(
      overlay,
      (x, y, width, height) => {
        setMenu({ kind, anchor: { x, y, width, height } })
      },
      () => console.warn('Unable to measure the model option menu anchor')
    )
  }
  const selectModel = (model: UnifiedModel) => {
    props.onSelect(model)
    closeMenu()
  }
  const selectOption = (key: 'reasoning' | 'speed', value: string) => {
    if (!props.selectedModel) return
    props.onSelect(props.selectedModel, { ...props.selectedOptions, [key]: value })
    closeMenu()
  }

  return (
    <View
      collapsable={false}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        setViewport(current =>
          current.width === width && current.height === height ? current : { width, height }
        )
      }}
      ref={overlayRef}
      style={styles.overlay}
      testID="advanced-model-overlay"
    >
      <View
        accessibilityElementsHidden={Boolean(menu)}
        importantForAccessibility={menu ? 'no-hide-descendants' : 'auto'}
        style={styles.overlay}
      >
        <Pressable
          accessibilityLabel="关闭高级模型设置"
          accessibilityRole="button"
          onPress={props.onDismiss}
          style={[styles.backdrop, { backgroundColor: appearance.backdropColor }]}
          testID="advanced-model-backdrop"
        />
        <ModelControlSurface
          style={[
            styles.sheet,
            {
              height: Math.max(
                viewport.height * 0.52,
                Math.min(340, viewport.height - insets.top - 16)
              ),
              paddingBottom: Math.max(insets.bottom, 18),
            },
          ]}
          testID="advanced-model-sheet"
        >
          <Pressable
            accessibilityLabel="关闭模型选择"
            accessibilityRole="button"
            hitSlop={16}
            onPress={props.onDismiss}
            style={styles.handleButton}
            testID="advanced-model-close"
          >
            <View style={styles.handle} />
          </Pressable>
          <View style={styles.titleRow}>
            <Text style={styles.title} variant="titleMedium">
              高级
            </Text>
            <Ionicons color={theme.colors.onSurface} name="chevron-forward" size={21} />
          </View>
          {props.loading ? (
            <ActivityIndicator
              accessibilityLabel="正在加载设备模型"
              testID="device-models-loading"
            />
          ) : null}
          {props.error ? (
            <Text style={styles.error} testID="device-models-error">
              {props.error}
            </Text>
          ) : null}
          <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetContent}>
            <View style={styles.group}>
              <AdvancedRow
                label="模型"
                onPress={target => openMenu('model', target)}
                testID="advanced-model-row"
                value={props.selectedModel ? modelLabel(props.selectedModel) : '选择模型'}
              />
              <View style={styles.rowDivider} />
              <AdvancedRow
                disabled={!props.selectedModel || efforts.length === 0}
                label="智能"
                onPress={target => openMenu('reasoning', target)}
                testID="advanced-reasoning-row"
                value={reasoningLabel(selectedEffort) || '默认'}
              />
            </View>
            <View style={[styles.group, styles.speedGroup]}>
              <AdvancedRow
                disabled={!speedSupported}
                label="速度"
                onPress={target => openMenu('speed', target)}
                testID="advanced-speed-row"
                value={speedLabel(props.selectedOptions.speed)}
              />
            </View>
          </ScrollView>
        </ModelControlSurface>
      </View>
      {menu ? (
        <ModelOptionPopover
          anchor={menu.anchor}
          key={menu.kind}
          kind={menu.kind}
          onDismiss={closeMenu}
          viewport={{ ...viewport, topInset: insets.top, bottomInset: insets.bottom }}
        >
          {menu.kind === 'model' ? (
            <>
              {sections.map(section => (
                <View key={section.label}>
                  {sections.length > 1 ? (
                    <Text style={styles.menuSection} variant="labelLarge">
                      {section.label}
                    </Text>
                  ) : null}
                  {section.groups.map(group => (
                    <View
                      key={group.config.id}
                      testID={`model-group-${section.label}-${group.config.id}`}
                    >
                      <Text style={styles.menuSection} variant="bodySmall">
                        {group.config.label}
                      </Text>
                      {group.models.map(model => (
                        <OptionMenuItem
                          key={modelSelectionKey(model)}
                          selected={isSameModelSelection(model, props.selectedModel)}
                          onPress={() => selectModel(model)}
                          testID={`model-option-${model.type}-${model.name}`}
                          title={modelLabel(model)}
                        />
                      ))}
                    </View>
                  ))}
                </View>
              ))}
              {!sections.length ? (
                <Text style={styles.empty} testID="model-menu-empty">
                  {props.loading ? '正在加载模型…' : '暂无可用模型'}
                </Text>
              ) : null}
              <View style={styles.rowDivider} />
              <OptionMenuItem
                disabled={props.loading}
                icon="refresh-outline"
                onPress={() => void props.onLoadModels(true)}
                testID="refresh-device-models"
                title="刷新模型"
              />
            </>
          ) : menu.kind === 'reasoning' ? (
            efforts.map(effort => (
              <OptionMenuItem
                key={effort}
                selected={selectedEffort === effort}
                onPress={() => selectOption('reasoning', effort)}
                testID={`reasoning-option-${effort}`}
                title={reasoningLabel(effort)}
              />
            ))
          ) : (
            SPEED_OPTIONS.map(speed => (
              <OptionMenuItem
                key={speed}
                selected={(props.selectedOptions.speed ?? 'standard') === speed}
                onPress={() => selectOption('speed', speed)}
                testID={`speed-option-${speed}`}
                title={speedLabel(speed)}
              />
            ))
          )}
        </ModelOptionPopover>
      ) : null}
    </View>
  )
}

function AdvancedRow({
  disabled,
  label,
  onPress,
  testID,
  value,
}: {
  disabled?: boolean
  label: string
  onPress: (target: View) => void
  testID: string
  value: string
}) {
  const theme = useTheme()
  const ref = useRef<View>(null)
  return (
    <Pressable
      accessibilityLabel={`${label}，${value}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        if (ref.current) onPress(ref.current)
      }}
      ref={ref}
      style={({ pressed }) => [
        rowStyles.row,
        pressed && rowStyles.pressed,
        disabled && rowStyles.disabled,
      ]}
      testID={testID}
    >
      <Text style={rowStyles.rowLabel} variant="titleMedium">
        {label}
      </Text>
      <Text numberOfLines={1} style={rowStyles.rowValue} variant="titleMedium">
        {value}
      </Text>
      <View style={rowStyles.chevrons}>
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-up" size={14} />
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-down" size={14} />
      </View>
    </Pressable>
  )
}

function OptionMenuItem({
  disabled = false,
  icon,
  onPress,
  selected = false,
  testID,
  title,
}: {
  disabled?: boolean
  icon?: keyof typeof Ionicons.glyphMap
  onPress: () => void
  selected?: boolean
  testID: string
  title: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="menuitem"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        rowStyles.option,
        pressed && rowStyles.pressed,
        disabled && rowStyles.disabled,
      ]}
      testID={testID}
    >
      <View style={rowStyles.check}>
        {selected || icon ? (
          <Ionicons
            color={theme.colors.onSurface}
            name={selected ? 'checkmark' : icon!}
            size={20}
          />
        ) : null}
      </View>
      <Text style={rowStyles.optionLabel} variant="bodyLarge">
        {title}
      </Text>
    </Pressable>
  )
}

function createStyles(colors: MD3Theme['colors'], dark: boolean) {
  return StyleSheet.create({
    overlay: { position: 'absolute', inset: 0, justifyContent: 'flex-end' },
    backdrop: { position: 'absolute', inset: 0 },
    sheet: {
      marginHorizontal: 8,
      marginBottom: 8,
      borderRadius: 42,
      paddingHorizontal: 16,
      overflow: 'hidden',
    },
    handleButton: { height: 12, alignItems: 'center', justifyContent: 'center' },
    handle: {
      width: 58,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.onSurfaceVariant,
      opacity: 0.55,
    },
    titleRow: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    title: { color: colors.onSurface, fontWeight: '500' },
    sheetContent: { flex: 1 },
    error: { color: colors.error, marginBottom: 12 },
    group: {
      borderRadius: 24,
      overflow: 'hidden',
      backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.065)',
    },
    speedGroup: { marginTop: 34 },
    rowDivider: {
      height: StyleSheet.hairlineWidth,
      marginHorizontal: 16,
      backgroundColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)',
    },
    menuSection: { paddingHorizontal: 44, paddingVertical: 8, color: colors.onSurfaceVariant },
    empty: { paddingHorizontal: 24, paddingVertical: 16, color: colors.onSurfaceVariant },
  })
}

const rowStyles = StyleSheet.create({
  row: { minHeight: 50, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  rowLabel: { flex: 1, fontWeight: '400' },
  rowValue: { maxWidth: '58%', fontWeight: '400', textAlign: 'right' },
  chevrons: { width: 20, marginLeft: 6, alignItems: 'center' },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.42 },
  option: {
    minHeight: 44,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  check: { width: 20, alignItems: 'center' },
  optionLabel: { flex: 1 },
})
