import Ionicons from '@expo/vector-icons/Ionicons'
import { GlassView } from 'expo-glass-effect'
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Menu, Portal, Text, useTheme, type MD3Theme } from 'react-native-paper'
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
import {
  modelControlAppearance,
  type ModelControlAppearance,
} from '@/domain/modelControlPresentation'
import type { ModelOptions, UnifiedModel } from '@/types/runtime'
import { ModelControlSurface } from './ModelControlSurface'

interface ModelPickerScreenProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedOptions: ModelOptions
  onDismiss: () => void
  onSelect: (model: UnifiedModel, options?: ModelOptions) => void
}

type AdvancedMenu = 'model' | 'reasoning' | 'speed' | null

export function ModelPickerScreen(props: ModelPickerScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const appearance = useMemo(() => modelControlAppearance(theme.dark), [theme.dark])
  const styles = useMemo(() => createStyles(theme.colors, appearance), [appearance, theme.colors])
  const [menu, setMenu] = useState<AdvancedMenu>(null)
  const models = useMemo(
    () => orderModels(selectableModels(props.models), props.selectedModel),
    [props.models, props.selectedModel]
  )
  const efforts = props.selectedModel ? reasoningEfforts(props.selectedModel) : []
  const selectedEffort = resolvedReasoningEffort(
    props.selectedModel,
    props.selectedOptions.reasoning
  )
  const speedSupported = modelSupportsSpeed(props.selectedModel)

  const selectModel = (model: UnifiedModel) => {
    props.onSelect(model)
    setMenu(null)
  }
  const selectOption = (key: 'reasoning' | 'speed', value: string) => {
    if (!props.selectedModel) return
    props.onSelect(props.selectedModel, { ...props.selectedOptions, [key]: value })
    setMenu(null)
  }

  return (
    <Portal.Host>
      <View style={styles.overlay} testID="advanced-model-overlay">
        <Pressable
          accessibilityLabel="关闭高级模型设置"
          onPress={props.onDismiss}
          style={styles.backdrop}
          testID="advanced-model-backdrop"
        />
        <ModelControlSurface
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 18),
            },
          ]}
          testID="advanced-model-sheet"
        >
          <Pressable
            accessibilityLabel="关闭模型选择"
            accessibilityRole="button"
            hitSlop={12}
            onPress={props.onDismiss}
            style={styles.handleButton}
            testID="advanced-model-close"
          >
            <View style={styles.handle} />
          </Pressable>
          <View style={styles.titleRow}>
            <Text style={styles.title} variant="titleLarge">
              高级
            </Text>
            <Ionicons color={theme.colors.onSurface} name="chevron-forward" size={21} />
          </View>

          <View style={styles.group}>
            <GlassView
              colorScheme={appearance.colorScheme}
              glassEffectStyle="clear"
              pointerEvents="none"
              style={glassStyles.fill}
              tintColor={appearance.groupTintColor}
            />
            <AdvancedOptionMenu
              contentStyle={styles.modelMenu}
              onDismiss={() => setMenu(null)}
              visible={menu === 'model'}
              anchor={
                <AdvancedRow
                  label="模型"
                  onPress={() => setMenu('model')}
                  testID="advanced-model-row"
                  value={props.selectedModel ? modelLabel(props.selectedModel) : '选择模型'}
                />
              }
            >
              <ScrollView showsVerticalScrollIndicator={false} style={styles.modelMenuScroll}>
                {models.slice(0, 2).map(model => (
                  <ModelMenuItem
                    key={modelKey(model)}
                    model={model}
                    onPress={() => selectModel(model)}
                    selected={sameModel(model, props.selectedModel)}
                  />
                ))}
                {models.length > 2 ? (
                  <>
                    <View
                      style={[styles.menuDivider, { backgroundColor: theme.colors.outlineVariant }]}
                    />
                    <Text style={styles.menuSection} variant="labelLarge">
                      其他模型
                    </Text>
                    {models.slice(2).map(model => (
                      <ModelMenuItem
                        key={modelKey(model)}
                        model={model}
                        onPress={() => selectModel(model)}
                        selected={sameModel(model, props.selectedModel)}
                      />
                    ))}
                  </>
                ) : null}
              </ScrollView>
            </AdvancedOptionMenu>

            <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} />

            <AdvancedOptionMenu
              contentStyle={styles.optionMenu}
              onDismiss={() => setMenu(null)}
              visible={menu === 'reasoning'}
              anchor={
                <AdvancedRow
                  disabled={!props.selectedModel || efforts.length === 0}
                  label="智能"
                  onPress={() => setMenu('reasoning')}
                  testID="advanced-reasoning-row"
                  value={reasoningLabel(selectedEffort) || '默认'}
                />
              }
            >
              {efforts.map(effort => (
                <Menu.Item
                  key={effort}
                  leadingIcon={selectedEffort === effort ? 'check' : undefined}
                  onPress={() => selectOption('reasoning', effort)}
                  testID={`reasoning-option-${effort}`}
                  title={reasoningLabel(effort)}
                />
              ))}
            </AdvancedOptionMenu>
          </View>

          <View style={[styles.group, styles.speedGroup]}>
            <GlassView
              colorScheme={appearance.colorScheme}
              glassEffectStyle="clear"
              pointerEvents="none"
              style={glassStyles.fill}
              tintColor={appearance.groupTintColor}
            />
            <AdvancedOptionMenu
              contentStyle={styles.optionMenu}
              onDismiss={() => setMenu(null)}
              visible={menu === 'speed'}
              anchor={
                <AdvancedRow
                  disabled={!speedSupported}
                  label="速度"
                  onPress={() => setMenu('speed')}
                  testID="advanced-speed-row"
                  value={speedLabel(props.selectedOptions.speed)}
                />
              }
            >
              {SPEED_OPTIONS.map(speed => (
                <Menu.Item
                  key={speed}
                  leadingIcon={
                    (props.selectedOptions.speed ?? 'standard') === speed ? 'check' : undefined
                  }
                  onPress={() => selectOption('speed', speed)}
                  testID={`speed-option-${speed}`}
                  title={speedLabel(speed)}
                />
              ))}
            </AdvancedOptionMenu>
          </View>
        </ModelControlSurface>
      </View>
    </Portal.Host>
  )
}

function AdvancedOptionMenu({
  anchor,
  children,
  contentStyle,
  onDismiss,
  visible,
}: {
  anchor: ReactNode
  children: ReactNode
  contentStyle: object
  onDismiss: () => void
  visible: boolean
}) {
  const theme = useTheme()
  const appearance = modelControlAppearance(theme.dark)
  return (
    <Menu
      anchor={anchor}
      anchorPosition="top"
      contentStyle={contentStyle}
      onDismiss={onDismiss}
      visible={visible}
    >
      <GlassView
        colorScheme={appearance.colorScheme}
        glassEffectStyle="regular"
        pointerEvents="none"
        style={glassStyles.fill}
        tintColor={appearance.menuTintColor}
      />
      {children}
    </Menu>
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
  onPress: () => void
  testID: string
  value: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        advancedRowStyles.row,
        pressed && advancedRowStyles.pressed,
        disabled && advancedRowStyles.disabled,
      ]}
      testID={testID}
    >
      <Text style={advancedRowStyles.rowLabel} variant="titleMedium">
        {label}
      </Text>
      <Text numberOfLines={1} style={advancedRowStyles.rowValue} variant="titleMedium">
        {value}
      </Text>
      <View style={advancedRowStyles.chevrons}>
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-up" size={14} />
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-down" size={14} />
      </View>
    </Pressable>
  )
}

function ModelMenuItem({
  model,
  onPress,
  selected,
}: {
  model: UnifiedModel
  onPress: () => void
  selected: boolean
}) {
  return (
    <Menu.Item
      leadingIcon={selected ? 'check' : undefined}
      onPress={onPress}
      testID={`model-option-${model.type}-${model.name}`}
      title={modelLabel(model)}
    />
  )
}

function orderModels(models: UnifiedModel[], selected: UnifiedModel | null): UnifiedModel[] {
  if (!selected) return models
  return [
    ...models.filter(model => sameModel(model, selected)),
    ...models.filter(model => !sameModel(model, selected)),
  ]
}

function sameModel(left: UnifiedModel, right: UnifiedModel | null): boolean {
  return Boolean(right && left.name === right.name && left.type === right.type)
}

function modelKey(model: UnifiedModel): string {
  return `${model.type}:${model.namespace ?? ''}:${model.name}`
}

function createStyles(colors: MD3Theme['colors'], appearance: ModelControlAppearance) {
  return StyleSheet.create({
    overlay: {
      position: 'absolute',
      inset: 0,
      justifyContent: 'flex-end',
    },
    backdrop: {
      position: 'absolute',
      inset: 0,
      backgroundColor: appearance.backdropColor,
    },
    sheet: {
      height: '52%',
      marginBottom: 8,
      borderRadius: 42,
      paddingHorizontal: 16,
      overflow: 'hidden',
    },
    handleButton: {
      height: 25,
      alignItems: 'center',
      justifyContent: 'center',
    },
    handle: {
      width: 58,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.onSurfaceVariant,
      opacity: 0.55,
    },
    titleRow: {
      height: 60,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    title: { color: colors.onSurface, fontWeight: '500' },
    group: {
      borderRadius: 24,
      overflow: 'hidden',
      backgroundColor: appearance.groupBackgroundColor,
    },
    speedGroup: { marginTop: 34 },
    rowDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
    modelMenu: {
      width: 260,
      maxHeight: 520,
      overflow: 'hidden',
      borderRadius: 24,
      backgroundColor: appearance.menuBackgroundColor,
    },
    modelMenuScroll: { maxHeight: 500 },
    optionMenu: {
      minWidth: 180,
      overflow: 'hidden',
      borderRadius: 24,
      backgroundColor: appearance.menuBackgroundColor,
    },
    menuDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, marginVertical: 6 },
    menuSection: { paddingHorizontal: 24, paddingVertical: 8, color: colors.onSurfaceVariant },
  })
}

const advancedRowStyles = StyleSheet.create({
  row: {
    minHeight: 60,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowLabel: { flex: 1, fontWeight: '400' },
  rowValue: { maxWidth: '58%', fontWeight: '400', textAlign: 'right' },
  chevrons: { width: 20, marginLeft: 6, alignItems: 'center' },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.42 },
})

const glassStyles = StyleSheet.create({
  fill: { position: 'absolute', inset: 0 },
})
