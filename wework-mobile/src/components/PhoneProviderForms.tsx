import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Switch, TextInput, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import {
  phoneModelProviders,
  type PhoneProviderDraft,
  type PhoneProviderSnapshot,
} from '@/services/phoneModelProviders'
import { phoneLocalModels } from '@/services/phoneLocalModels'
import type { LocalRuntime } from '@/services/localRuntime'
import { confirmNativeAction, showErrorAlert } from '@/services/errorAlerts'
import { SettingsAction, settingsStyles } from './SettingsScreen'

export function ProviderField({
  id,
  label,
  value,
  onChange,
  secure,
  placeholder,
  disabled,
  numeric,
  multiline,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  secure?: boolean
  placeholder?: string
  disabled?: boolean
  numeric?: boolean
  multiline?: boolean
}) {
  const theme = useTheme()
  return (
    <View style={settingsStyles.field}>
      <Text variant="labelLarge">{label}</Text>
      <TextInput
        testID={id}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        placeholder={placeholder}
        editable={!disabled}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? 'number-pad' : 'default'}
        placeholderTextColor={theme.colors.onSurfaceVariant}
        style={[
          styles.input,
          { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
        ]}
      />
    </View>
  )
}

export function ProviderToggle({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.label}>{label}</Text>
      <Switch
        testID={id}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
    </View>
  )
}
export function ProviderChoices<T extends string>({
  id,
  label,
  value,
  choices,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: T
  choices: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <View style={settingsStyles.field}>
      <Text variant="labelLarge">{label}</Text>
      <View style={styles.choices}>
        {choices.map(choice => (
          <SettingsAction
            key={choice.value}
            testID={`${id}-${choice.value}`}
            secondary={value !== choice.value}
            disabled={disabled}
            onPress={() => onChange(choice.value)}
          >{`${value === choice.value ? '✓ ' : ''}${choice.label}`}</SettingsAction>
        ))}
      </View>
    </View>
  )
}

/** Read once per editor: subscriptions must never overwrite an unsaved draft. */
export function usePhoneProviderDraft(providerId?: string) {
  const [draft, setDraft] = useState<PhoneProviderDraft | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const captured = useRef<PhoneProviderSnapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void phoneModelProviders
      .providers()
      .then(snapshot => {
        if (!active) return
        const provider = providerId ? snapshot.providers.find(row => row.id === providerId) : null
        if (providerId && !provider) throw new Error('服务商已被删除，请返回重新选择')
        captured.current = snapshot
        setDraft(provider ? structuredClone(provider) : null)
      })
      .catch(cause => {
        if (active) setError(cause)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [providerId, attempt])
  const persist = async (next: PhoneProviderDraft) => {
    if (!captured.current) throw new Error('模型配置尚未加载，请重试')
    const saved = await phoneModelProviders.saveProvider(next, captured.current.revision)
    captured.current = saved
    setDraft(saved.providers.find(row => row.id === next.id)!)
  }
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  return { draft, setDraft, captured, persist, loading, error, retry }
}

export function usePhoneProviderOperation(
  runtime: LocalRuntime | null,
  onChanged: () => Promise<void>
) {
  const mounted = useRef(true)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const act = async (operation: () => Promise<void>, options: { readOnly?: boolean } = {}) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setWriting(!options.readOnly)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      if (mounted.current) setError(cause)
      else if (!options.readOnly) showErrorAlert(cause, { title: '模型配置未完成' })
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
        setWriting(false)
      }
    }
  }
  const synchronize = async () => {
    if (runtime?.status.state === 'running') {
      await phoneLocalModels.sync(runtime)
      await onChanged()
    }
  }
  return { busy, writing, error, act, synchronize, mounted }
}

/** Native back buttons and gestures share the same discard boundary. */
export function useProviderDraftGuard(dirty: boolean, busy: boolean, onBack: () => void) {
  const navigation = useNavigation()
  const [finished, setFinished] = useState(false)
  usePreventRemove(!finished && (dirty || busy), ({ data }) => {
    if (busy) return
    confirmNativeAction('放弃未保存的修改？', '已保存的服务商和模型不会改变。', {
      confirmLabel: '放弃修改',
      destructive: true,
      onConfirm: () => navigation.dispatch(data.action),
    })
  })
  const completed = useRef(false)
  useEffect(() => {
    if (finished && !completed.current) {
      completed.current = true
      onBack()
    }
  }, [finished, onBack])
  return () => setFinished(true)
}

const styles = StyleSheet.create({
  input: {
    minHeight: 52,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  toggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { flex: 1 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
})
