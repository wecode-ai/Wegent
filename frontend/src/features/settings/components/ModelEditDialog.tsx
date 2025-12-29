// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { EyeIcon, EyeSlashIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { useTranslation } from '@/hooks/useTranslation';
import {
  modelApis,
  ModelCRD,
  ModelCategoryType,
  TTSConfig,
  STTConfig,
  EmbeddingConfig,
  RerankConfig,
} from '@/apis/models';

interface ModelEditDialogProps {
  open: boolean;
  model: ModelCRD | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  groupName?: string;
  scope?: 'personal' | 'group';
}

// Model category type options
const MODEL_CATEGORY_OPTIONS: { value: ModelCategoryType; labelKey: string }[] = [
  { value: 'llm', labelKey: 'models.model_category_type_llm' },
  // { value: 'tts', labelKey: 'models.model_category_type_tts' },
  // { value: 'stt', labelKey: 'models.model_category_type_stt' },
  { value: 'embedding', labelKey: 'models.model_category_type_embedding' },
  { value: 'rerank', labelKey: 'models.model_category_type_rerank' },
];

// Protocol options by model category type
const PROTOCOL_BY_CATEGORY: Record<
  ModelCategoryType,
  { value: string; label: string; hint?: string }[]
> = {
  llm: [
    { value: 'openai', label: 'OpenAI', hint: 'Agno' },
    { value: 'anthropic', label: 'Anthropic', hint: 'Claude Code' },
    { value: 'gemini', label: 'Gemini', hint: 'Google' },
  ],
  tts: [
    { value: 'openai', label: 'OpenAI TTS' },
    { value: 'azure', label: 'Azure Cognitive Services' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'custom', label: 'Custom API' },
  ],
  stt: [
    { value: 'openai', label: 'OpenAI Whisper' },
    { value: 'azure', label: 'Azure Speech Services' },
    { value: 'google', label: 'Google Cloud STT' },
    { value: 'custom', label: 'Custom API' },
  ],
  embedding: [
    { value: 'openai', label: 'OpenAI Embeddings' },
    { value: 'cohere', label: 'Cohere Embed' },
    { value: 'jina', label: 'Jina AI' },
    { value: 'custom', label: 'Custom API' },
  ],
  rerank: [
    { value: 'cohere', label: 'Cohere Rerank' },
    { value: 'jina', label: 'Jina Reranker' },
    { value: 'custom', label: 'Custom API' },
  ],
};

const OPENAI_MODEL_OPTIONS = [
  { value: 'gpt-4o', label: 'gpt-4o (Recommended)' },
  { value: 'gpt-4-turbo', label: 'gpt-4-turbo' },
  { value: 'gpt-4', label: 'gpt-4' },
  { value: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo' },
  { value: 'custom', label: 'Custom...' },
];

const ANTHROPIC_MODEL_OPTIONS = [
  { value: 'claude-sonnet-4', label: 'claude-sonnet-4 (Recommended)' },
  { value: 'claude-opus-4', label: 'claude-opus-4' },
  { value: 'claude-haiku-4.5', label: 'claude-haiku-4.5' },
  { value: 'custom', label: 'Custom...' },
];

const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3-pro', label: 'gemini-3-pro (Recommended)' },
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  { value: 'custom', label: 'Custom...' },
];

const ModelEditDialog: React.FC<ModelEditDialogProps> = ({
  open,
  model,
  onClose,
  toast,
  groupName,
  scope,
}) => {
  const { t } = useTranslation();
  const isEditing = !!model;
  const isGroupScope = scope === 'group';

  // Form state
  const [modelIdName, setModelIdName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modelCategoryType, setModelCategoryType] = useState<ModelCategoryType>('llm');
  const [providerType, setProviderType] = useState<string>('openai');
  const [modelId, setModelId] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');
  const [customHeadersError, setCustomHeadersError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Type-specific config state
  // TTS
  const [ttsVoice, setTtsVoice] = useState('');
  const [ttsSpeed, setTtsSpeed] = useState<number>(1.0);
  const [ttsOutputFormat, setTtsOutputFormat] = useState<'mp3' | 'wav'>('mp3');
  // STT
  const [sttLanguage, setSttLanguage] = useState('');
  const [sttTranscriptionFormat, setSttTranscriptionFormat] = useState<'text' | 'srt' | 'vtt'>(
    'text'
  );
  // Embedding
  const [embeddingDimensions, setEmbeddingDimensions] = useState<number | undefined>(undefined);
  const [embeddingEncodingFormat, setEmbeddingEncodingFormat] = useState<'float' | 'base64'>(
    'float'
  );
  // Rerank
  const [rerankTopN, setRerankTopN] = useState<number | undefined>(undefined);
  const [rerankReturnDocuments, setRerankReturnDocuments] = useState(true);

  // Reset form when dialog opens/closes or model changes
  useEffect(() => {
    if (open) {
      if (model) {
        setModelIdName(model.metadata.name || '');
        setDisplayName(model.metadata.displayName || '');
        // Set model category type
        setModelCategoryType(model.spec.modelType || 'llm');
        const modelType = model.spec.modelConfig?.env?.model;
        // Map model type to provider type
        if (modelType === 'claude') {
          setProviderType('anthropic');
        } else if (
          modelType === 'openai' ||
          modelType === 'gemini' ||
          modelType === 'cohere' ||
          modelType === 'jina' ||
          modelType === 'custom'
        ) {
          setProviderType(modelType);
        } else {
          setProviderType('openai'); // Default fallback
        }
        setApiKey(model.spec.modelConfig?.env?.api_key || '');
        setBaseUrl(model.spec.modelConfig?.env?.base_url || '');
        const headers = model.spec.modelConfig?.env?.custom_headers;
        if (headers && Object.keys(headers).length > 0) {
          setCustomHeaders(JSON.stringify(headers, null, 2));
        } else {
          setCustomHeaders('');
        }
        // Load type-specific configs
        if (model.spec.ttsConfig) {
          setTtsVoice(model.spec.ttsConfig.voice || '');
          setTtsSpeed(model.spec.ttsConfig.speed || 1.0);
          setTtsOutputFormat((model.spec.ttsConfig.output_format as 'mp3' | 'wav') || 'mp3');
        }
        if (model.spec.sttConfig) {
          setSttLanguage(model.spec.sttConfig.language || '');
          setSttTranscriptionFormat(
            (model.spec.sttConfig.transcription_format as 'text' | 'srt' | 'vtt') || 'text'
          );
        }
        if (model.spec.embeddingConfig) {
          setEmbeddingDimensions(model.spec.embeddingConfig.dimensions);
          setEmbeddingEncodingFormat(
            (model.spec.embeddingConfig.encoding_format as 'float' | 'base64') || 'float'
          );
        }
        if (model.spec.rerankConfig) {
          setRerankTopN(model.spec.rerankConfig.top_n);
          setRerankReturnDocuments(model.spec.rerankConfig.return_documents ?? true);
        }
      } else {
        // Reset for new model
        setModelIdName('');
        setDisplayName('');
        setModelCategoryType('llm');
        setProviderType('openai');
        setModelId('');
        setCustomModelId('');
        setApiKey('');
        setBaseUrl('');
        setCustomHeaders('');
        // Reset type-specific configs
        setTtsVoice('');
        setTtsSpeed(1.0);
        setTtsOutputFormat('mp3');
        setSttLanguage('');
        setSttTranscriptionFormat('text');
        setEmbeddingDimensions(undefined);
        setEmbeddingEncodingFormat('float');
        setRerankTopN(undefined);
        setRerankReturnDocuments(true);
      }
      setCustomHeadersError('');
      setShowApiKey(false);
    }
  }, [open, model]);

  // Determine model options based on model category type and provider
  // For embedding/rerank, only show "Custom..." option since they don't use preset LLM models
  const modelOptions =
    modelCategoryType === 'embedding' || modelCategoryType === 'rerank'
      ? [{ value: 'custom', label: 'Custom...' }]
      : providerType === 'openai'
        ? OPENAI_MODEL_OPTIONS
        : providerType === 'gemini'
          ? GEMINI_MODEL_OPTIONS
          : ANTHROPIC_MODEL_OPTIONS;

  // Get available protocols for current category type
  const availableProtocols = PROTOCOL_BY_CATEGORY[modelCategoryType] || [];

  // Handle model category type change
  const handleModelCategoryTypeChange = (value: ModelCategoryType) => {
    setModelCategoryType(value);
    // Reset provider to first available option for new category
    const protocols = PROTOCOL_BY_CATEGORY[value];
    if (protocols && protocols.length > 0) {
      setProviderType(protocols[0].value);
    }
    // For embedding/rerank, automatically set to custom mode
    if (value === 'embedding' || value === 'rerank') {
      setModelId('custom');
      setCustomModelId('');
    } else {
      setModelId('');
      setCustomModelId('');
    }
  };

  // Set model ID when model changes
  useEffect(() => {
    if (model?.spec.modelConfig?.env?.model_id) {
      const id = model.spec.modelConfig.env.model_id;
      const isPreset = modelOptions.some(opt => opt.value === id && opt.value !== 'custom');
      if (isPreset) {
        setModelId(id);
        setCustomModelId('');
      } else {
        setModelId('custom');
        setCustomModelId(id);
      }
    }
  }, [model, modelOptions]);

  const handleProviderChange = (value: string) => {
    setProviderType(value);
    setModelId('');
    setCustomModelId('');
    // Only set default base URL for LLM models
    if (modelCategoryType === 'llm') {
      if (value === 'openai') {
        setBaseUrl('https://api.openai.com/v1');
      } else if (value === 'gemini') {
        setBaseUrl('https://generativelanguage.googleapis.com');
      } else {
        setBaseUrl('https://api.anthropic.com');
      }
    }
  };

  const handleTestConnection = async () => {
    const finalModelId = modelId === 'custom' ? customModelId : modelId;
    if (!finalModelId || !apiKey) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      });
      return;
    }

    // Parse custom headers for test connection
    const parsedHeaders = validateCustomHeaders(customHeaders);
    if (parsedHeaders === null) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.custom_headers_invalid'),
      });
      return;
    }

    setTesting(true);
    try {
      const result = await modelApis.testConnection({
        provider_type: providerType as 'openai' | 'anthropic' | 'gemini',
        model_id: finalModelId,
        api_key: apiKey,
        base_url: baseUrl || undefined,
        custom_headers: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
        model_category_type: modelCategoryType,
      });

      if (result.success) {
        toast({
          title: t('common:models.test_success'),
          description: result.message,
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('common:models.test_failed'),
          description: result.message,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:models.test_failed'),
        description: (error as Error).message,
      });
    } finally {
      setTesting(false);
    }
  };

  const validateCustomHeaders = (value: string): Record<string, string> | null => {
    if (!value.trim()) {
      setCustomHeadersError('');
      return {};
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setCustomHeadersError(t('common:models.errors.custom_headers_invalid_object'));
        return null;
      }
      for (const [_key, val] of Object.entries(parsed)) {
        if (typeof val !== 'string') {
          setCustomHeadersError(t('common:models.errors.custom_headers_values_must_be_strings'));
          return null;
        }
      }
      setCustomHeadersError('');
      return parsed as Record<string, string>;
    } catch {
      setCustomHeadersError(t('common:models.errors.custom_headers_invalid_json'));
      return null;
    }
  };

  const handleCustomHeadersChange = (value: string) => {
    setCustomHeaders(value);
    validateCustomHeaders(value);
  };

  const handleSave = async () => {
    if (isGroupScope && !isEditing && !groupName) {
      toast({
        variant: 'destructive',
        title: '请先选择一个群组',
        description: '在群组模式下创建模型时必须选择目标群组',
      });
      return;
    }

    if (!modelIdName.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.id_required'),
      });
      return;
    }

    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
    if (!nameRegex.test(modelIdName)) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.id_invalid'),
      });
      return;
    }

    const finalModelId = modelId === 'custom' ? customModelId : modelId;
    if (!finalModelId) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      });
      return;
    }

    if (!apiKey.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.api_key_required'),
      });
      return;
    }

    const parsedHeaders = validateCustomHeaders(customHeaders);
    if (parsedHeaders === null) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.custom_headers_invalid'),
      });
      return;
    }

    setSaving(true);
    try {
      // Build type-specific config based on modelCategoryType
      const ttsConfig: TTSConfig | undefined =
        modelCategoryType === 'tts'
          ? {
              voice: ttsVoice || undefined,
              speed: ttsSpeed,
              output_format: ttsOutputFormat,
            }
          : undefined;

      const sttConfig: STTConfig | undefined =
        modelCategoryType === 'stt'
          ? {
              language: sttLanguage || undefined,
              transcription_format: sttTranscriptionFormat,
            }
          : undefined;

      const embeddingConfig: EmbeddingConfig | undefined =
        modelCategoryType === 'embedding'
          ? {
              dimensions: embeddingDimensions,
              encoding_format: embeddingEncodingFormat,
            }
          : undefined;

      const rerankConfig: RerankConfig | undefined =
        modelCategoryType === 'rerank'
          ? {
              top_n: rerankTopN,
              return_documents: rerankReturnDocuments,
            }
          : undefined;

      // Map provider type to model field value
      // For LLM: openai -> openai, anthropic -> claude, gemini -> gemini
      // For embedding/rerank: use provider type directly (openai, cohere, jina, custom)
      let modelFieldValue = providerType;
      if (modelCategoryType === 'llm') {
        if (providerType === 'anthropic') {
          modelFieldValue = 'claude';
        }
      }

      const modelCRD: ModelCRD = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelIdName.trim(),
          namespace: isGroupScope && groupName ? groupName : 'default',
          displayName: displayName.trim() || undefined,
        },
        spec: {
          modelConfig: {
            env: {
              model: modelFieldValue,
              model_id: finalModelId,
              api_key: apiKey,
              ...(baseUrl && { base_url: baseUrl }),
              ...(parsedHeaders &&
                Object.keys(parsedHeaders).length > 0 && { custom_headers: parsedHeaders }),
            },
          },
          modelType: modelCategoryType,
          ...(ttsConfig && { ttsConfig }),
          ...(sttConfig && { sttConfig }),
          ...(embeddingConfig && { embeddingConfig }),
          ...(rerankConfig && { rerankConfig }),
        },
        status: {
          state: 'Available',
        },
      };

      if (isEditing && model) {
        await modelApis.updateModel(model.metadata.name, modelCRD);
        toast({
          title: t('common:models.update_success'),
        });
      } else {
        await modelApis.createModel(modelCRD);
        toast({
          title: t('common:models.create_success'),
        });
      }

      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing
          ? t('common:models.errors.update_failed')
          : t('common:models.errors.create_failed'),
        description: (error as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  const apiKeyPlaceholder =
    providerType === 'openai' ? 'sk-...' : providerType === 'gemini' ? 'AIza...' : 'sk-ant-...';
  const baseUrlPlaceholder =
    providerType === 'openai'
      ? 'https://api.openai.com/v1'
      : providerType === 'gemini'
        ? 'https://generativelanguage.googleapis.com'
        : 'https://api.anthropic.com';

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('common:models.edit_title') : t('common:models.create_title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Model Category Type Selector - New */}
          <div className="space-y-2">
            <Label htmlFor="modelCategoryType" className="text-sm font-medium">
              {t('common:models.model_category_type')} <span className="text-red-400">*</span>
            </Label>
            <Select
              value={modelCategoryType}
              onValueChange={(value: ModelCategoryType) => handleModelCategoryTypeChange(value)}
              disabled={isEditing}
            >
              <SelectTrigger className="bg-base">
                <SelectValue placeholder={t('common:models.select_model_category_type')} />
              </SelectTrigger>
              <SelectContent>
                {MODEL_CATEGORY_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model ID and Display Name - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="modelIdName" className="text-sm font-medium">
                {t('common:models.model_id_name')} <span className="text-red-400">*</span>
              </Label>
              <Input
                id="modelIdName"
                value={modelIdName}
                onChange={e => setModelIdName(e.target.value)}
                placeholder="my-gpt-model"
                disabled={isEditing}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">
                {isEditing ? t('common:models.id_readonly_hint') : t('common:models.id_hint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm font-medium">
                {t('common:models.display_name')}
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('common:models.display_name_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('common:models.display_name_hint')}</p>
            </div>
          </div>

          {/* Provider Type and Model ID - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider_type" className="text-sm font-medium">
                {t('common:models.provider_type')} <span className="text-red-400">*</span>
              </Label>
              <Select value={providerType} onValueChange={handleProviderChange}>
                <SelectTrigger className="bg-base">
                  <SelectValue placeholder={t('common:models.select_provider')} />
                </SelectTrigger>
                <SelectContent>
                  {availableProtocols.map(protocol => (
                    <SelectItem key={protocol.value} value={protocol.value}>
                      <div className="flex items-center gap-2">
                        <span>{protocol.label}</span>
                        {protocol.hint && (
                          <span className="text-xs text-text-muted">({protocol.hint})</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model_id" className="text-sm font-medium">
                {t('common:models.model_id')} <span className="text-red-400">*</span>
              </Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger className="bg-base">
                  <SelectValue placeholder={t('common:models.select_model_id')} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelId === 'custom' && (
                <Input
                  value={customModelId}
                  onChange={e => setCustomModelId(e.target.value)}
                  placeholder={t('common:models.custom_model_id_placeholder')}
                  className="mt-2 bg-base"
                />
              )}
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="api_key" className="text-sm font-medium">
              {t('common:models.api_key')} <span className="text-red-400">*</span>
            </Label>
            <div className="relative">
              <Input
                id="api_key"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={apiKeyPlaceholder}
                className="bg-base pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <EyeSlashIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="base_url" className="text-sm font-medium">
              {t('common:models.base_url')}
            </Label>
            <Input
              id="base_url"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={baseUrlPlaceholder}
              className="bg-base"
            />
            <p className="text-xs text-text-muted">{t('common:models.base_url_hint')}</p>
          </div>

          {/* Custom Headers */}
          <div className="space-y-2">
            <Label htmlFor="custom_headers" className="text-sm font-medium">
              {t('common:models.custom_headers')}
            </Label>
            <Textarea
              id="custom_headers"
              value={customHeaders}
              onChange={e => handleCustomHeadersChange(e.target.value)}
              placeholder={`{\n  "X-Custom-Header": "value",\n  "Authorization": "Bearer token"\n}`}
              className={`bg-base font-mono text-sm min-h-[100px] ${customHeadersError ? 'border-error' : ''}`}
            />
            {customHeadersError && <p className="text-xs text-error">{customHeadersError}</p>}
            <p className="text-xs text-text-muted">{t('common:models.custom_headers_hint')}</p>
          </div>

          {/* TTS-specific fields */}
          {modelCategoryType === 'tts' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">TTS Configuration</h4>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tts_voice" className="text-sm font-medium">
                    {t('common:models.tts_voice')}
                  </Label>
                  <Input
                    id="tts_voice"
                    value={ttsVoice}
                    onChange={e => setTtsVoice(e.target.value)}
                    placeholder="alloy, echo, fable, onyx, nova, shimmer"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.tts_voice_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tts_speed" className="text-sm font-medium">
                    {t('common:models.tts_speed')}
                  </Label>
                  <Input
                    id="tts_speed"
                    type="number"
                    step="0.1"
                    min="0.25"
                    max="4.0"
                    value={ttsSpeed}
                    onChange={e => setTtsSpeed(parseFloat(e.target.value) || 1.0)}
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.tts_speed_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tts_output_format" className="text-sm font-medium">
                    {t('common:models.tts_output_format')}
                  </Label>
                  <Select
                    value={ttsOutputFormat}
                    onValueChange={(v: 'mp3' | 'wav') => setTtsOutputFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mp3">MP3</SelectItem>
                      <SelectItem value="wav">WAV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* STT-specific fields */}
          {modelCategoryType === 'stt' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">STT Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="stt_language" className="text-sm font-medium">
                    {t('common:models.stt_language')}
                  </Label>
                  <Input
                    id="stt_language"
                    value={sttLanguage}
                    onChange={e => setSttLanguage(e.target.value)}
                    placeholder="en, zh, es, fr, de, ja, ko"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.stt_language_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stt_format" className="text-sm font-medium">
                    {t('common:models.stt_transcription_format')}
                  </Label>
                  <Select
                    value={sttTranscriptionFormat}
                    onValueChange={(v: 'text' | 'srt' | 'vtt') => setSttTranscriptionFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="srt">SRT</SelectItem>
                      <SelectItem value="vtt">VTT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Embedding-specific fields */}
          {modelCategoryType === 'embedding' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">Embedding Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="embedding_dimensions" className="text-sm font-medium">
                    {t('common:models.embedding_dimensions')}
                  </Label>
                  <Input
                    id="embedding_dimensions"
                    type="number"
                    value={embeddingDimensions || ''}
                    onChange={e => setEmbeddingDimensions(parseInt(e.target.value) || undefined)}
                    placeholder="1536 (OpenAI), 768 (Cohere)"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">
                    {t('common:models.embedding_dimensions_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding_format" className="text-sm font-medium">
                    {t('common:models.embedding_encoding_format')}
                  </Label>
                  <Select
                    value={embeddingEncodingFormat}
                    onValueChange={(v: 'float' | 'base64') => setEmbeddingEncodingFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="float">Float</SelectItem>
                      <SelectItem value="base64">Base64</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Rerank-specific fields */}
          {modelCategoryType === 'rerank' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">Rerank Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rerank_top_n" className="text-sm font-medium">
                    {t('common:models.rerank_top_n')}
                  </Label>
                  <Input
                    id="rerank_top_n"
                    type="number"
                    value={rerankTopN || ''}
                    onChange={e => setRerankTopN(parseInt(e.target.value) || undefined)}
                    placeholder="Default: return all"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.rerank_top_n_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rerank_return_docs" className="text-sm font-medium">
                    {t('common:models.rerank_return_documents')}
                  </Label>
                  <Select
                    value={rerankReturnDocuments ? 'true' : 'false'}
                    onValueChange={v => setRerankReturnDocuments(v === 'true')}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !modelId || !apiKey}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <BeakerIcon className="w-4 h-4 mr-1" />
            {t('common:models.test_connection')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ModelEditDialog;
