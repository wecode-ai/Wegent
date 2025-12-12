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
import { modelApis, ModelCRD } from '@/apis/models';

interface ModelEditDialogProps {
  open: boolean;
  model: ModelCRD | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  groupName?: string;
  scope?: 'personal' | 'group';
}

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
  const { t } = useTranslation('common');
  const isEditing = !!model;
  const isGroupScope = scope === 'group';

  // Form state
  const [modelIdName, setModelIdName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [providerType, setProviderType] = useState<'openai' | 'anthropic' | 'gemini'>('openai');
  const [modelId, setModelId] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');
  const [customHeadersError, setCustomHeadersError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Reset form when dialog opens/closes or model changes
  useEffect(() => {
    if (open) {
      if (model) {
        setModelIdName(model.metadata.name || '');
        setDisplayName(model.metadata.displayName || '');
        const modelType = model.spec.modelConfig?.env?.model;
        if (modelType === 'openai') setProviderType('openai');
        else if (modelType === 'gemini') setProviderType('gemini');
        else if (modelType === 'claude') setProviderType('anthropic');
        else setProviderType('openai');
        setApiKey(model.spec.modelConfig?.env?.api_key || '');
        setBaseUrl(model.spec.modelConfig?.env?.base_url || '');
        const headers = model.spec.modelConfig?.env?.custom_headers;
        if (headers && Object.keys(headers).length > 0) {
          setCustomHeaders(JSON.stringify(headers, null, 2));
        } else {
          setCustomHeaders('');
        }
      } else {
        // Reset for new model
        setModelIdName('');
        setDisplayName('');
        setProviderType('openai');
        setModelId('');
        setCustomModelId('');
        setApiKey('');
        setBaseUrl('');
        setCustomHeaders('');
      }
      setCustomHeadersError('');
      setShowApiKey(false);
    }
  }, [open, model]);

  // Determine model options based on provider
  const modelOptions =
    providerType === 'openai'
      ? OPENAI_MODEL_OPTIONS
      : providerType === 'gemini'
        ? GEMINI_MODEL_OPTIONS
        : ANTHROPIC_MODEL_OPTIONS;

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

  const handleProviderChange = (value: 'openai' | 'anthropic' | 'gemini') => {
    setProviderType(value);
    setModelId('');
    setCustomModelId('');
    if (value === 'openai') {
      setBaseUrl('https://api.openai.com/v1');
    } else if (value === 'gemini') {
      setBaseUrl('https://generativelanguage.googleapis.com');
    } else {
      setBaseUrl('https://api.anthropic.com');
    }
  };

  const handleTestConnection = async () => {
    const finalModelId = modelId === 'custom' ? customModelId : modelId;
    if (!finalModelId || !apiKey) {
      toast({
        variant: 'destructive',
        title: t('models.errors.model_id_required'),
      });
      return;
    }

    setTesting(true);
    try {
      const result = await modelApis.testConnection({
        provider_type: providerType,
        model_id: finalModelId,
        api_key: apiKey,
        base_url: baseUrl || undefined,
      });

      if (result.success) {
        toast({
          title: t('models.test_success'),
          description: result.message,
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('models.test_failed'),
          description: result.message,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('models.test_failed'),
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
        setCustomHeadersError(t('models.errors.custom_headers_invalid_object'));
        return null;
      }
      for (const [_key, val] of Object.entries(parsed)) {
        if (typeof val !== 'string') {
          setCustomHeadersError(t('models.errors.custom_headers_values_must_be_strings'));
          return null;
        }
      }
      setCustomHeadersError('');
      return parsed as Record<string, string>;
    } catch {
      setCustomHeadersError(t('models.errors.custom_headers_invalid_json'));
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
        title: t('models.errors.id_required'),
      });
      return;
    }

    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
    if (!nameRegex.test(modelIdName)) {
      toast({
        variant: 'destructive',
        title: t('models.errors.id_invalid'),
      });
      return;
    }

    const finalModelId = modelId === 'custom' ? customModelId : modelId;
    if (!finalModelId) {
      toast({
        variant: 'destructive',
        title: t('models.errors.model_id_required'),
      });
      return;
    }

    if (!apiKey.trim()) {
      toast({
        variant: 'destructive',
        title: t('models.errors.api_key_required'),
      });
      return;
    }

    const parsedHeaders = validateCustomHeaders(customHeaders);
    if (parsedHeaders === null) {
      toast({
        variant: 'destructive',
        title: t('models.errors.custom_headers_invalid'),
      });
      return;
    }

    setSaving(true);
    try {
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
              model:
                providerType === 'openai'
                  ? 'openai'
                  : providerType === 'gemini'
                    ? 'gemini'
                    : 'claude',
              model_id: finalModelId,
              api_key: apiKey,
              ...(baseUrl && { base_url: baseUrl }),
              ...(parsedHeaders &&
                Object.keys(parsedHeaders).length > 0 && { custom_headers: parsedHeaders }),
            },
          },
        },
        status: {
          state: 'Available',
        },
      };

      if (isEditing && model) {
        await modelApis.updateModel(model.metadata.name, modelCRD);
        toast({
          title: t('models.update_success'),
        });
      } else {
        await modelApis.createModel(modelCRD);
        toast({
          title: t('models.create_success'),
        });
      }

      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing ? t('models.errors.update_failed') : t('models.errors.create_failed'),
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
          <DialogTitle>{isEditing ? t('models.edit_title') : t('models.create_title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Model ID and Display Name - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="modelIdName" className="text-sm font-medium">
                {t('models.model_id_name')} <span className="text-red-400">*</span>
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
                {isEditing ? t('models.id_readonly_hint') : t('models.id_hint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm font-medium">
                {t('models.display_name')}
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('models.display_name_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('models.display_name_hint')}</p>
            </div>
          </div>

          {/* Provider Type and Model ID - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider_type" className="text-sm font-medium">
                {t('models.provider_type')} <span className="text-red-400">*</span>
              </Label>
              <Select value={providerType} onValueChange={handleProviderChange}>
                <SelectTrigger className="bg-base">
                  <SelectValue placeholder={t('models.select_provider')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">
                    <div className="flex items-center gap-2">
                      <span>OpenAI</span>
                      <span className="text-xs text-text-muted">(Agno)</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="anthropic">
                    <div className="flex items-center gap-2">
                      <span>Anthropic</span>
                      <span className="text-xs text-text-muted">(Claude Code)</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="gemini">
                    <div className="flex items-center gap-2">
                      <span>Gemini</span>
                      <span className="text-xs text-text-muted">(Google)</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model_id" className="text-sm font-medium">
                {t('models.model_id')} <span className="text-red-400">*</span>
              </Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger className="bg-base">
                  <SelectValue placeholder={t('models.select_model_id')} />
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
                  placeholder={t('models.custom_model_id_placeholder')}
                  className="mt-2 bg-base"
                />
              )}
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="api_key" className="text-sm font-medium">
              {t('models.api_key')} <span className="text-red-400">*</span>
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
              {t('models.base_url')}
            </Label>
            <Input
              id="base_url"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={baseUrlPlaceholder}
              className="bg-base"
            />
            <p className="text-xs text-text-muted">{t('models.base_url_hint')}</p>
          </div>

          {/* Custom Headers */}
          <div className="space-y-2">
            <Label htmlFor="custom_headers" className="text-sm font-medium">
              {t('models.custom_headers')}
            </Label>
            <Textarea
              id="custom_headers"
              value={customHeaders}
              onChange={e => handleCustomHeadersChange(e.target.value)}
              placeholder={`{\n  "X-Custom-Header": "value",\n  "Authorization": "Bearer token"\n}`}
              className={`bg-base font-mono text-sm min-h-[100px] ${customHeadersError ? 'border-error' : ''}`}
            />
            {customHeadersError && <p className="text-xs text-error">{customHeadersError}</p>}
            <p className="text-xs text-text-muted">{t('models.custom_headers_hint')}</p>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !modelId || !apiKey}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <BeakerIcon className="w-4 h-4 mr-1" />
            {t('models.test_connection')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ModelEditDialog;
