import Ionicons from '@expo/vector-icons/Ionicons'
import type { GlassColorScheme } from 'expo-glass-effect'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ActivityIndicator, Portal, Text, useTheme } from 'react-native-paper'

import type { DeviceInfo } from '@/types/runtime'
import { KeyboardSafeTextInput, KeyboardSafeView } from './KeyboardSafeInput'
import {
  LiquidGlassButton,
  LiquidGlassSurface,
  liquidGlassAccentBorder,
  liquidGlassAccentTint,
} from './LiquidGlass'

interface ProjectDialogProps {
  visible: boolean
  devices: DeviceInfo[]
  selectedDeviceId: string | null
  onDismiss: () => void
  onCreate: (input: { deviceId: string; workspacePath: string; name: string }) => Promise<void>
}

export function ProjectDialog(props: ProjectDialogProps) {
  const theme = useTheme()
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const [deviceId, setDeviceId] = useState(props.selectedDeviceId ?? '')
  const [name, setName] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const onlineDevices = useMemo(
    () => props.devices.filter(device => device.status !== 'offline'),
    [props.devices]
  )

  useEffect(() => {
    if (!props.visible) return
    const selectedDevice = onlineDevices.find(device => device.device_id === props.selectedDeviceId)
    setDeviceId(selectedDevice?.device_id ?? onlineDevices[0]?.device_id ?? '')
    setError(null)
  }, [onlineDevices, props.selectedDeviceId, props.visible])

  const submit = async () => {
    if (!deviceId || !workspacePath.trim()) {
      setError('请选择 Executor 并填写远程绝对路径')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await props.onCreate({ deviceId, workspacePath, name })
      setName('')
      setWorkspacePath('')
      props.onDismiss()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  if (!props.visible) return null

  const fieldBackground = theme.dark ? 'rgba(128,128,128,0.16)' : 'rgba(128,128,128,0.12)'

  return (
    <Portal>
      <KeyboardSafeView style={styles.keyboardLayer}>
        <Pressable
          accessibilityLabel="取消新建云端项目"
          accessibilityRole="button"
          onPress={props.onDismiss}
          style={styles.backdrop}
          testID="project-dialog-backdrop"
        >
          <Pressable
            accessibilityViewIsModal
            onPress={event => event.stopPropagation()}
            style={styles.positioner}
            testID="project-dialog"
          >
            <LiquidGlassSurface
              colorScheme={glassColorScheme}
              fallbackStyle={{
                backgroundColor: theme.colors.elevation.level3,
                borderColor: theme.colors.outlineVariant,
              }}
              glassEffectStyle="regular"
              isInteractive={false}
              style={styles.dialogGlass}
            >
              <ScrollView
                bounces={false}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.header}>
                  <View style={styles.titleBlock}>
                    <Text style={styles.title} variant="headlineSmall">
                      新建云端项目
                    </Text>
                    <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyMedium">
                      选择 Executor，并指定项目所在的远程路径
                    </Text>
                  </View>
                  <LiquidGlassButton
                    accessibilityLabel="关闭"
                    colorScheme={glassColorScheme}
                    contentStyle={styles.closeContent}
                    fallbackStyle={{
                      backgroundColor: theme.colors.surfaceVariant,
                      borderColor: theme.colors.outlineVariant,
                    }}
                    onPress={props.onDismiss}
                    style={styles.closeGlass}
                    testID="project-create-close"
                  >
                    <Ionicons color={theme.colors.onSurface} name="close" size={20} />
                  </LiquidGlassButton>
                </View>

                <Text style={styles.sectionLabel} variant="labelMedium">
                  EXECUTOR
                </Text>
                <ScrollView
                  contentContainerStyle={styles.devices}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                >
                  {onlineDevices.map(device => {
                    const selected = deviceId === device.device_id
                    return (
                      <LiquidGlassButton
                        accessibilityLabel={`选择 ${device.name}`}
                        colorScheme={glassColorScheme}
                        contentStyle={styles.deviceContent}
                        fallbackStyle={{
                          backgroundColor: selected
                            ? liquidGlassAccentTint
                            : theme.colors.surfaceVariant,
                          borderColor: selected
                            ? liquidGlassAccentBorder
                            : theme.colors.outlineVariant,
                        }}
                        glassEffectStyle={selected ? 'clear' : 'regular'}
                        key={device.device_id}
                        onPress={() => setDeviceId(device.device_id)}
                        style={styles.deviceGlass}
                        testID={`project-device-${device.device_id}`}
                        tintColor={selected ? liquidGlassAccentTint : undefined}
                      >
                        <View style={styles.onlineDot} />
                        <Ionicons
                          color={selected ? '#ffffff' : theme.colors.onSurface}
                          name="laptop-outline"
                          size={18}
                        />
                        <Text
                          numberOfLines={1}
                          style={{ color: selected ? '#ffffff' : theme.colors.onSurface }}
                          variant="labelLarge"
                        >
                          {device.name}
                        </Text>
                      </LiquidGlassButton>
                    )
                  })}
                  {onlineDevices.length === 0 ? (
                    <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyMedium">
                      暂无在线 Executor
                    </Text>
                  ) : null}
                </ScrollView>

                <View style={[styles.field, { backgroundColor: fieldBackground }]}>
                  <Ionicons color={theme.colors.onSurfaceVariant} name="folder-outline" size={21} />
                  <KeyboardSafeTextInput
                    accessibilityLabel="项目名称"
                    onChangeText={setName}
                    placeholder="项目名称（可选）"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    returnKeyType="next"
                    style={[styles.input, { color: theme.colors.onSurface }]}
                    testID="project-name"
                    value={name}
                  />
                </View>
                <View style={[styles.field, { backgroundColor: fieldBackground }]}>
                  <Ionicons
                    color={theme.colors.onSurfaceVariant}
                    name="terminal-outline"
                    size={21}
                  />
                  <KeyboardSafeTextInput
                    accessibilityLabel="远程绝对路径"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setWorkspacePath}
                    placeholder="/workspace/my-project"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    returnKeyType="done"
                    style={[styles.input, { color: theme.colors.onSurface }]}
                    testID="project-workspace-path"
                    value={workspacePath}
                  />
                </View>

                {error ? (
                  <View style={styles.errorRow}>
                    <Ionicons color={theme.colors.error} name="alert-circle-outline" size={18} />
                    <Text
                      style={[styles.errorText, { color: theme.colors.error }]}
                      variant="bodySmall"
                    >
                      {error}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.actions}>
                  <LiquidGlassButton
                    colorScheme={glassColorScheme}
                    contentStyle={styles.actionContent}
                    disabled={submitting}
                    fallbackStyle={{
                      backgroundColor: theme.colors.surfaceVariant,
                      borderColor: theme.colors.outlineVariant,
                    }}
                    onPress={props.onDismiss}
                    style={styles.actionGlass}
                    testID="project-create-cancel"
                  >
                    <Text style={styles.actionLabel} variant="labelLarge">
                      取消
                    </Text>
                  </LiquidGlassButton>
                  <LiquidGlassButton
                    colorScheme={glassColorScheme}
                    contentStyle={styles.actionContent}
                    disabled={submitting}
                    fallbackStyle={{
                      backgroundColor: liquidGlassAccentTint,
                      borderColor: liquidGlassAccentBorder,
                    }}
                    onPress={() => void submit()}
                    style={styles.actionGlass}
                    testID="project-create-submit"
                    tintColor={liquidGlassAccentTint}
                  >
                    {submitting ? <ActivityIndicator color="#ffffff" size={18} /> : null}
                    <Text style={styles.primaryLabel} variant="labelLarge">
                      创建
                    </Text>
                  </LiquidGlassButton>
                </View>
              </ScrollView>
            </LiquidGlassSurface>
          </Pressable>
        </Pressable>
      </KeyboardSafeView>
    </Portal>
  )
}

const styles = StyleSheet.create({
  keyboardLayer: { flex: 1 },
  backdrop: {
    flex: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.14)',
  },
  positioner: { width: '100%', maxWidth: 380, maxHeight: '86%' },
  dialogGlass: { borderRadius: 32, overflow: 'hidden' },
  content: { padding: 20, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  titleBlock: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontWeight: '600' },
  closeGlass: { width: 38, height: 38, borderRadius: 19 },
  closeContent: {
    width: '100%',
    height: '100%',
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: { marginTop: 4, opacity: 0.58 },
  devices: { minHeight: 40, alignItems: 'center', gap: 8 },
  deviceGlass: { height: 40, maxWidth: 240, borderRadius: 20 },
  deviceContent: {
    height: '100%',
    paddingHorizontal: 14,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#20c77a' },
  field: {
    minHeight: 54,
    borderRadius: 17,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  input: { flex: 1, minWidth: 0, minHeight: 54, fontSize: 17, paddingVertical: 0 },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingHorizontal: 4 },
  errorText: { flex: 1 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  actionGlass: { flex: 1, height: 46, borderRadius: 23 },
  actionContent: {
    width: '100%',
    height: '100%',
    paddingHorizontal: 18,
    borderRadius: 23,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionLabel: { fontWeight: '600' },
  primaryLabel: { color: '#ffffff', fontWeight: '600' },
})
