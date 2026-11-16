import * as Crypto from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Text } from 'react-native-paper'
import { type ModelApiFormat, type PhoneProviderDraft } from '@/services/phoneModelProviders'
import type { LocalRuntime } from '@/services/localRuntime'
import { LOCAL_MODEL_PROVIDER_PROFILES } from '../../../wework/src/features/model-settings/localModelProviders'
import { detectProviderPreset } from '../../../wework/src/features/model-settings/providerPresets'
import {
  SettingsAction,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  settingsStyles,
} from './SettingsScreen'
import {
  ProviderChoices,
  ProviderField,
  ProviderToggle,
  usePhoneProviderDraft,
  usePhoneProviderOperation,
  useProviderDraftGuard,
} from './PhoneProviderForms'
import { ErrorNotice } from './errors/ErrorNotice'
import { ModelPrivacyNotice } from './ModelPrivacyNotice'
import { confirmModelDataSharing } from '@/services/privacyPolicy'
import { confirmNativeAction } from '@/services/errorAlerts'

export function PhoneProviderEditorScreen({
  providerId,
  runtime,
  onBack,
  onChanged,
  onPrivacy,
  onSaved,
}: {
  providerId?: string
  runtime: LocalRuntime | null
  onBack: () => void
  onChanged: () => Promise<void>
  onPrivacy: () => void
  onSaved: (id: string) => void
}) {
  const state = usePhoneProviderDraft(providerId)
  const operation = usePhoneProviderOperation(runtime, onChanged)
  const initial = useRef<string | null>(null)
  const [preset, setPreset] = useState('')
  const [choosing, setChoosing] = useState(!providerId)
  const [advanced, setAdvanced] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const finish = useProviderDraftGuard(
    initial.current !== null && JSON.stringify(state.draft) !== initial.current,
    operation.writing,
    () => (savedId ? onSaved(savedId) : onBack())
  )
  useEffect(() => {
    if (state.loading || initial.current !== null) return
    if (state.draft) {
      initial.current = JSON.stringify(state.draft)
      setPreset(detectProviderPreset(state.draft))
    }
  }, [state.loading, state.draft])
  const draft = state.draft
  const patch = (value: Partial<PhoneProviderDraft>) =>
    state.setDraft(current => (current ? { ...current, ...value } : current))
  const selectPreset = (id: string) => {
    if (operation.busy || state.loading) return
    const profile = LOCAL_MODEL_PROVIDER_PROFILES.find(row => row.id === id)!
    const next: PhoneProviderDraft = {
      id: Crypto.randomUUID(),
      name: profile.displayName,
      base_url: profile.baseUrl,
      api_format: profile.apiFormat,
      request_path: profile.requestPath,
      models_path: profile.modelsPath,
      models_api_key_header: profile.modelsApiKeyHeader,
      models: [],
    }
    initial.current = JSON.stringify(null)
    state.setDraft(next)
    setPreset(id)
    setChoosing(false)
  }
  const save = () =>
    operation.act(async () => {
      if (!draft) return
      await state.persist(draft)
      await operation.synchronize()
      if (operation.mounted.current) {
        setSavedId(draft.id)
        finish()
      }
    })
  return (
    <SettingsPage title={providerId ? '编辑服务连接' : '添加服务商'} onBack={onBack} keyboard>
      <ModelPrivacyNotice testID="provider-privacy" onReadPolicy={onPrivacy} />
      {state.loading && <ActivityIndicator />}
      {!providerId && choosing && (
        <SettingsGroup title="选择服务商">
          {LOCAL_MODEL_PROVIDER_PROFILES.map((profile, index) => (
            <SettingsRow
              key={profile.id}
              testID={`provider-preset-${profile.id}`}
              icon="server-outline"
              label={`${preset === profile.id ? '✓ ' : ''}${profile.id === 'custom' ? '自定义兼容服务' : profile.displayName}`}
              separator={index > 0}
              disabled={operation.busy || state.loading || !state.captured.current}
              onPress={() => selectPreset(profile.id)}
            />
          ))}
        </SettingsGroup>
      )}
      {draft && (
        <View style={settingsStyles.form}>
          {!providerId && !choosing && (
            <SettingsAction
              testID="provider-change-preset"
              secondary
              disabled={
                operation.busy || state.captured.current?.providers.some(row => row.id === draft.id)
              }
              onPress={() =>
                confirmNativeAction('更换服务商？', '当前未保存的连接草稿将被替换。', {
                  confirmLabel: '更换服务商',
                  onConfirm: () => setChoosing(true),
                })
              }
            >
              更换服务商
            </SettingsAction>
          )}
          <ProviderField
            id="provider-name"
            label="连接名称"
            value={draft.name}
            onChange={name => patch({ name })}
            disabled={operation.busy}
            placeholder="例如：工作账号、个人账号"
          />
          <ProviderField
            id="provider-api-key"
            label="API Key"
            value={draft.api_key ?? ''}
            secure={!showKey}
            onChange={api_key => patch({ api_key: api_key || undefined })}
            placeholder={
              draft.api_key_configured ? '已安全保存，留空保留原密钥' : '服务无需鉴权时可留空'
            }
            disabled={operation.busy}
          />
          <SettingsAction
            testID="provider-key-visibility"
            secondary
            onPress={() => setShowKey(value => !value)}
          >
            {showKey ? '隐藏密钥' : '显示密钥'}
          </SettingsAction>
          <ProviderToggle
            id="provider-enabled"
            label="启用此服务连接"
            value={draft.enabled !== false}
            onChange={enabled => patch({ enabled })}
            disabled={operation.busy}
          />
          <SettingsAction
            testID="provider-advanced"
            secondary
            onPress={() => setAdvanced(value => !value)}
          >
            {advanced ? '收起连接设置' : '连接设置'}
          </SettingsAction>
          {(preset === 'custom' || advanced) && (
            <>
              <ProviderField
                id="provider-base-url"
                label="API Base URL"
                value={draft.base_url}
                onChange={base_url => patch({ base_url })}
                disabled={operation.busy}
                placeholder="https://api.example.com/v1"
              />
              <ProviderChoices<ModelApiFormat>
                id="provider-protocol"
                label="API 协议"
                value={draft.api_format}
                choices={(
                  ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const
                ).map(value => ({ value, label: value }))}
                onChange={api_format => patch({ api_format, request_path: undefined })}
                disabled={operation.busy}
              />
              <ProviderField
                id="provider-request-path"
                label="请求路径（可选）"
                value={draft.request_path ?? ''}
                onChange={value => patch({ request_path: value || undefined })}
                placeholder="按协议自动选择"
                disabled={operation.busy}
              />
              <ProviderField
                id="provider-models-path"
                label="模型列表路径"
                value={draft.models_path ?? ''}
                onChange={value => patch({ models_path: value || undefined })}
                placeholder="/models"
                disabled={operation.busy}
              />
              <ProviderChoices
                id="provider-models-auth"
                label="模型列表鉴权"
                value={draft.models_api_key_header ?? 'Authorization'}
                choices={[
                  { value: 'Authorization', label: 'Authorization' },
                  { value: 'X-Api-Key', label: 'X-Api-Key' },
                ]}
                onChange={models_api_key_header => patch({ models_api_key_header })}
                disabled={operation.busy}
              />
            </>
          )}
          <Text>保存服务连接后，可获取模型列表或手动添加多个模型。密钥由此连接下的模型共用。</Text>
          <SettingsAction
            testID="provider-save"
            disabled={operation.busy || state.loading}
            onPress={() => confirmModelDataSharing(save)}
          >
            保存并管理模型
          </SettingsAction>
        </View>
      )}
      {(state.error ?? operation.error) != null && (
        <ErrorNotice
          error={state.error ?? operation.error}
          onRetry={state.error ? state.retry : undefined}
          title="服务连接未完成"
          testID="provider-error"
        />
      )}
    </SettingsPage>
  )
}
