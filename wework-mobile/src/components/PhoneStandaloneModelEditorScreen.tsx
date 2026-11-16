import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native'
import { confirmNativeAction, showErrorAlert } from '@/services/errorAlerts'
import { Text, useTheme } from 'react-native-paper'
import type { LocalRuntime } from '@/services/localRuntime'
import {
  phoneLocalModels,
  normalizePhoneLocalModel,
  phoneResponsesUrl,
  type PhoneLocalModelInput,
} from '@/services/phoneLocalModels'
import { testModelConnection } from '../../../packages/chat-core/src/model-connection-probe'
import { SettingsAction, SettingsPage, settingsStyles } from './SettingsScreen'
import { ErrorNotice } from './errors/ErrorNotice'
import { ModelPrivacyNotice } from './ModelPrivacyNotice'
import { confirmModelDataSharing } from '@/services/privacyPolicy'

const emptyModel: PhoneLocalModelInput = {
  displayName: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelId: '',
}

export function PhoneStandaloneModelEditorScreen({
  modelId,
  runtime,
  onBack,
  onChanged,
  onPrivacy,
}: {
  modelId?: string
  runtime: LocalRuntime | null
  onBack: () => void
  onChanged: () => Promise<void>
  onPrivacy: () => void
}) {
  const theme = useTheme()
  const [draft, setDraft] = useState<PhoneLocalModelInput>(emptyModel)
  const [loading, setLoading] = useState(Boolean(modelId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [tested, setTested] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!modelId) return
    let active = true
    void phoneLocalModels
      .list()
      .then(models => {
        if (!active) return
        const model = models.find(row => row.id === modelId)
        if (!model) throw new Error('模型已被删除')
        setDraft(model)
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
  }, [modelId])
  const update = (key: keyof PhoneLocalModelInput, value: string) => {
    setDraft(current => ({ ...current, [key]: value }))
    setTested(false)
  }
  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      if (mounted.current) setError(cause)
      else showErrorAlert(cause, { title: '模型配置未完成' })
    } finally {
      setBusy(false)
    }
  }
  const synchronize = async () => {
    if (runtime?.status.state === 'running') {
      await phoneLocalModels.sync(runtime)
      await onChanged()
    }
  }
  const save = () =>
    act(async () => {
      const saved = await phoneLocalModels.save(draft)
      setDraft(saved)
      await synchronize()
      if (mounted.current) onBack()
    })
  const test = () =>
    act(async () => {
      const model = normalizePhoneLocalModel(draft)
      await testModelConnection({
        requestUrl: phoneResponsesUrl(model.baseUrl),
        modelId: model.modelId,
        apiKey: model.apiKey,
        apiFormat: 'openai-responses',
        toolProfile: 'function',
      })
      setTested(true)
    })
  const remove = () =>
    confirmNativeAction('删除模型', `删除“${draft.displayName || draft.modelId}”的本机配置？`, {
      confirmLabel: '删除',
      destructive: true,
      onConfirm: () =>
        act(async () => {
          if (!draft.id) return
          await phoneLocalModels.remove(draft.id)
          await synchronize()
          if (mounted.current) onBack()
        }),
    })
  let endpoint = ''
  try {
    endpoint = phoneResponsesUrl(draft.baseUrl)
  } catch {
    /* The editable field may be incomplete. */
  }
  const field = (
    key: 'displayName' | 'baseUrl' | 'apiKey' | 'modelId',
    label: string,
    placeholder: string
  ) => (
    <View style={settingsStyles.field}>
      <Text variant="labelLarge">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={`local-model-${key}`}
        value={draft[key]}
        onChangeText={value => update(key, value)}
        editable={!loading && !busy}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={key === 'apiKey'}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.onSurfaceVariant}
        style={[
          styles.input,
          { color: theme.colors.onSurface, backgroundColor: theme.colors.surfaceVariant },
        ]}
      />
    </View>
  )
  return (
    <SettingsPage title={modelId ? '编辑模型' : '添加模型'} onBack={onBack} keyboard>
      <ModelPrivacyNotice testID="local-model-privacy" onReadPolicy={onPrivacy} />
      {loading && <ActivityIndicator />}
      <View style={settingsStyles.form}>
        {field('displayName', '显示名称', '我的模型（可选）')}
        {field('baseUrl', 'API Base URL', 'https://api.example.com/v1')}
        <Text
          selectable
          variant="bodySmall"
          style={settingsStyles.hint}
          testID="local-model-endpoint"
        >
          请求地址：{endpoint}
        </Text>
        {field('apiKey', 'API Key', '服务无需鉴权时可留空')}
        {field('modelId', '模型 ID', '服务提供的模型 ID')}
        <Text variant="bodyMedium">协议：Responses API</Text>
        {error != null && (
          <ErrorNotice error={error} title="模型配置未完成" testID="local-model-error" />
        )}
        {tested && <Text testID="local-model-test-success">连接成功，模型工具调用验证通过。</Text>}
        <SettingsAction
          testID="local-model-test"
          onPress={() => void test()}
          disabled={busy || loading}
          secondary
        >
          测试连接
        </SettingsAction>
        <SettingsAction
          testID="local-model-save"
          onPress={() => confirmModelDataSharing(save)}
          disabled={busy || loading}
        >
          保存模型
        </SettingsAction>
        {draft.id && (
          <SettingsAction
            testID="local-model-delete"
            onPress={remove}
            disabled={busy || loading}
            secondary
          >
            删除模型
          </SettingsAction>
        )}
      </View>
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  input: {
    minHeight: 52,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
})
