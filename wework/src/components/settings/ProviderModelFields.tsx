import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from '@wegent/collaboration/controls/Collapsible'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'

import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { localModelSupportsImageInput } from '@/features/model-settings/localModelProviders'
import {
  defaultLocalModelToolProfile,
  listLocalModelConfigs,
  normalizeLocalModelCodexToolCompatibility,
  type LocalModelWebSearchMode,
} from '@/features/model-settings/localModelSettings'
import {
  type ModelProvider,
  type ProviderModel,
} from '@/features/model-settings/providerModelConfiguration'
import { CustomModelCapabilitiesForm } from './CustomModelCapabilitiesForm'

const FORMATS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const

/** Expose frequently edited model capabilities directly while grouping infrequent protocol controls. */
export function ProviderModelFields({
  model,
  provider,
  onChange,
}: {
  model: ProviderModel
  provider: ModelProvider
  onChange: (value: Partial<ProviderModel>) => void
}) {
  const { t } = useTranslation('modelConnections')
  const { t: common } = useTranslation('common')
  const format = model.api_format ?? provider.api_format
  const toolProfile = model.tool_profile ?? defaultLocalModelToolProfile(format)
  const compatibility = normalizeLocalModelCodexToolCompatibility(
    model.codex_tool_compatibility,
    format
  )
  const entry =
    model.catalog_entry ??
    createDefaultLocalModelCatalogEntry({
      id: model.id,
      displayName: model.display_name || model.model_id,
      toolProfile,
      contextWindow: model.context_window,
    })
  return (
    <div className="space-y-3">
      <CustomModelCapabilitiesForm
        entry={entry}
        apiFormat={format}
        codexToolCompatibility={compatibility}
        onCodexToolCompatibilityChange={value => onChange({ codex_tool_compatibility: value })}
        contextWindow={model.context_window?.toString() ?? ''}
        maxOutputTokens={model.max_output_tokens?.toString() ?? ''}
        onMaxOutputTokensChange={value =>
          onChange({ max_output_tokens: value ? Number(value) : undefined })
        }
        onContextWindowChange={value => {
          const context_window = value ? Number(value) : undefined
          onChange({
            context_window,
            ...(model.catalog_entry
              ? {
                  catalog_entry: {
                    ...model.catalog_entry,
                    context_window: context_window ?? 272_000,
                    max_context_window: context_window ?? 272_000,
                  },
                }
              : {}),
          })
        }}
        onChange={catalog_entry => onChange({ catalog_entry })}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm text-text-secondary">
          {common('workbench.local_model_web_search_label')}
          <SelectRoot
            value={normalizeSelectValue(model.web_search_mode ?? 'disabled')}
            onValueChange={selectedValue => {
              if (selectedValue !== null)
                return onChange({ web_search_mode: selectedValue as LocalModelWebSearchMode })
            }}
          >
            <SelectTrigger
              density="default"
              data-testid={`provider-model-web-search-${model.id}`}
              className="w-full min-w-0"
            />
            <SelectContent>
              {(['disabled', 'cached', 'live'] as const).map(value => (
                <SelectItem key={value} value={String(value)}>
                  {common(`workbench.local_model_web_search_${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectRoot>
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <Checkbox
            data-testid={`provider-model-image-generation-${model.id}`}
            checked={model.image_generation_enabled ?? false}
            onCheckedChange={checked => onChange({ image_generation_enabled: checked === true })}
          />
          {common('workbench.local_model_image_generation_label')}
        </label>
        <label className="grid gap-1 text-sm text-text-secondary md:col-span-2">
          {common('workbench.local_model_vision_proxy_label')}
          <SelectRoot
            value={normalizeSelectValue(model.vision_model_config_id ?? '')}
            onValueChange={selectedValue => {
              if (selectedValue !== null)
                return onChange({ vision_model_config_id: selectedValue || undefined })
            }}
          >
            <SelectTrigger
              density="default"
              data-testid={`provider-model-vision-${model.id}`}
              className="w-full min-w-0"
            />
            <SelectContent>
              <SelectItem value="">
                {common('workbench.local_model_vision_proxy_disabled')}
              </SelectItem>
              {model.vision_model_config_id &&
                !listLocalModelConfigs().some(item => item.id === model.vision_model_config_id) && (
                  <SelectItem value={String(model.vision_model_config_id)}>
                    {model.vision_model_config_id}
                  </SelectItem>
                )}
              {listLocalModelConfigs()
                .filter(
                  item => item.enabled && item.id !== model.id && localModelSupportsImageInput(item)
                )
                .map(item => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </SelectRoot>
        </label>
        <label className="grid gap-1 text-sm text-text-secondary md:col-span-2">
          {common('workbench.local_model_group_label')}
          <ControlInput
            density="default"
            data-testid={`provider-model-group-${model.id}`}
            className="w-full min-w-0"
            value={model.group ?? ''}
            onChange={event => onChange({ group: event.target.value || undefined })}
          />
        </label>
      </div>
      <CollapsibleRoot>
        <CollapsibleTrigger
          className="cursor-pointer text-xs text-text-secondary"
          data-testid="provider-model-fields-toggle"
        >
          {t('modelAdvanced')}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm text-text-secondary">
              {t('protocol')}
              <SelectRoot
                value={normalizeSelectValue(model.api_format ?? '')}
                onValueChange={selectedValue => {
                  if (selectedValue !== null)
                    return onChange({
                      api_format: (selectedValue as ProviderModel['api_format']) || undefined,
                      request_path: undefined,
                      tool_profile: undefined,
                      catalog_entry: undefined,
                    })
                }}
              >
                <SelectTrigger
                  density="default"
                  className="w-full min-w-0"
                  data-testid={`provider-model-protocol-${model.id}`}
                />
                <SelectContent>
                  <SelectItem value="">{t('inherit')}</SelectItem>
                  {FORMATS.map(value => (
                    <SelectItem value={String(value)} key={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectRoot>
            </label>
            <label className="space-y-1 text-sm text-text-secondary">
              {t('requestPath')}
              <ControlInput
                density="default"
                className="w-full min-w-0"
                data-testid={`provider-model-path-${model.id}`}
                value={model.request_path ?? ''}
                placeholder={t('inherit')}
                onChange={event => onChange({ request_path: event.target.value || undefined })}
              />
            </label>
            <label className="space-y-1 text-sm text-text-secondary">
              {t('toolProfile')}
              <SelectRoot
                value={normalizeSelectValue(model.tool_profile ?? '')}
                onValueChange={selectedValue => {
                  if (selectedValue !== null)
                    return onChange({
                      tool_profile: (selectedValue as ProviderModel['tool_profile']) || undefined,
                    })
                }}
              >
                <SelectTrigger
                  density="default"
                  className="w-full min-w-0"
                  data-testid={`provider-model-tools-${model.id}`}
                />
                <SelectContent>
                  <SelectItem value="">{t('automatic')}</SelectItem>
                  {(format === 'openai-responses'
                    ? ['custom', 'function', 'shell']
                    : ['function', 'shell']
                  ).map(value => (
                    <SelectItem value={String(value)} key={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectRoot>
            </label>
            {format === 'openai-responses' && (
              <label className="space-y-1 text-sm text-text-secondary">
                {t('toolCompatibility')}
                <SelectRoot
                  value={normalizeSelectValue(compatibility)}
                  onValueChange={selectedValue => {
                    if (selectedValue !== null)
                      return onChange({
                        codex_tool_compatibility:
                          selectedValue as ProviderModel['codex_tool_compatibility'],
                      })
                  }}
                >
                  <SelectTrigger
                    density="default"
                    className="w-full min-w-0"
                    data-testid={`provider-model-compatibility-${model.id}`}
                  />
                  <SelectContent>
                    <SelectItem value="native">native</SelectItem>
                    <SelectItem value="standard">standard</SelectItem>
                  </SelectContent>
                </SelectRoot>
              </label>
            )}
          </div>
        </CollapsiblePanel>
      </CollapsibleRoot>
    </div>
  )
}
