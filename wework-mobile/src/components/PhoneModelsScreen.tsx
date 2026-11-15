import { ActivityIndicator } from 'react-native'
import { Text } from 'react-native-paper'
import type { LocalRuntime, LocalRuntimeStatus } from '@/services/localRuntime'
import { usePhoneModelProviders } from '@/hooks/usePhoneModelProviders'
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  settingsStyles,
  usePhoneModels,
} from './SettingsScreen'
import { LocalRuntimeSettings } from './LocalRuntimeSettings'
import { ErrorNotice } from './errors/ErrorNotice'
import { ModelPrivacyNotice } from './ModelPrivacyNotice'
export { PhoneModelEditorScreen } from './PhoneModelEditorScreen'

export function PhoneModelsScreen({
  runtime,
  status,
  onBack,
  onAdd,
  onEdit,
  onAddStandalone,
  onEditStandalone,
  onAccount,
  onPrivacy,
}: {
  runtime: LocalRuntime | null
  status: LocalRuntimeStatus
  onBack: () => void
  onAdd: () => void
  onEdit: (id: string) => void
  onAddStandalone: () => void
  onEditStandalone: (id: string) => void
  onAccount: () => void
  onPrivacy: () => void
}) {
  const standalone = usePhoneModels()
  const { snapshot, error, retry } = usePhoneModelProviders()
  return (
    <SettingsPage title="模型与账号" onBack={onBack}>
      <ModelPrivacyNotice testID="models-privacy" onReadPolicy={onPrivacy} />
      <SettingsGroup title="OpenAI 账号">
        <SettingsRow
          icon="sparkles-outline"
          label="OpenAI 账号"
          onPress={onAccount}
          testID="models-openai-account"
        />
      </SettingsGroup>
      <SettingsGroup title="单独配置的模型">
        {standalone.models.map((model, index) => (
          <SettingsRow
            key={model.id}
            icon="cube-outline"
            label={model.displayName}
            onPress={() => onEditStandalone(model.id)}
            testID={`settings-model-${model.id}`}
            separator={index > 0}
          />
        ))}
        <SettingsRow
          icon="add"
          label="单独添加模型"
          onPress={onAddStandalone}
          testID="settings-add-model"
          separator={standalone.models.length > 0}
        />
      </SettingsGroup>
      {standalone.error != null && (
        <ErrorNotice error={standalone.error} testID="standalone-models-error" />
      )}
      <SettingsGroup title="模型服务商">
        {snapshot?.providers.map((provider, index) => (
          <SettingsRow
            key={provider.id}
            icon="server-outline"
            label={`${provider.name} · ${provider.models.length} 个模型${provider.enabled === false ? ' · 已停用' : ''}`}
            onPress={() => onEdit(provider.id)}
            testID={`settings-provider-${provider.id}`}
            separator={index > 0}
          />
        ))}
        <SettingsRow
          icon="add"
          label="添加服务商"
          onPress={onAdd}
          testID="settings-add-provider"
          separator={Boolean(snapshot?.providers.length)}
        />
      </SettingsGroup>
      <Text variant="bodySmall" style={settingsStyles.hint}>
        每个服务连接共用地址、协议和 API
        Key，可添加多个模型。密钥保存在本机安全存储中，后端登录不会改变这里的配置。
      </Text>
      {!runtime || status.state !== 'running' ? (
        <Text variant="bodySmall">本机执行就绪后，可在聊天中选择模型。</Text>
      ) : null}
      {error != null && <ErrorNotice error={error} onRetry={retry} testID="models-storage-error" />}
    </SettingsPage>
  )
}

export function CodexAccountScreen({
  runtime,
  status,
  error,
  onRetry,
  onBack,
  onChanged,
  onPrivacy,
}: {
  runtime: LocalRuntime | null
  status: LocalRuntimeStatus
  error: unknown
  onRetry: () => Promise<void>
  onBack: () => void
  onChanged: () => Promise<void>
  onPrivacy: () => void
}) {
  return (
    <SettingsPage title="OpenAI 账号" onBack={onBack}>
      <ModelPrivacyNotice testID="codex-account-privacy" onReadPolicy={onPrivacy} />
      {runtime ? (
        <LocalRuntimeSettings
          runtime={runtime}
          status={status}
          visible
          section="accounts"
          onChanged={onChanged}
        />
      ) : error != null ? (
        <ErrorNotice error={error} onRetry={onRetry} testID="codex-runtime-error" />
      ) : (
        <ActivityIndicator />
      )}
    </SettingsPage>
  )
}
