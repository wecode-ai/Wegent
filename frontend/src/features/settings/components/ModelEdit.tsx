// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelDetail, modelApis, ModelCreateRequest } from '@/apis/models';
import { useTranslation } from 'react-i18next';
import ClaudeModelForm from './modelForms/ClaudeModelForm';
import OpenAIModelForm from './modelForms/OpenAIModelForm';
import OpenRouterModelForm from './modelForms/OpenRouterModelForm';
import DeepSeekModelForm from './modelForms/DeepSeekModelForm';
import GLMModelForm from './modelForms/GLMModelForm';
import QwenModelForm from './modelForms/QwenModelForm';

interface ModelEditProps {
  models: ModelDetail[];
  setModels: React.Dispatch<React.SetStateAction<ModelDetail[]>>;
  editingModelId: number | null;
  cloningModel: ModelDetail | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

type ProviderType = 'claude' | 'openai' | 'openrouter' | 'deepseek' | 'glm' | 'qwen';

const ModelEdit: React.FC<ModelEditProps> = ({
  models,
  setModels,
  editingModelId,
  cloningModel,
  onClose,
  toast,
}) => {
  const { t } = useTranslation('common');

  const [modelSaving, setModelSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  // Current editing object
  const editingModel =
    editingModelId && editingModelId > 0
      ? models.find(m => m.id === editingModelId) || null
      : null;

  const baseModel = editingModel || cloningModel || null;

  const [modelName, setModelName] = useState(baseModel?.name || '');
  const [provider, setProvider] = useState<ProviderType>(
    (baseModel?.config?.env?.model as ProviderType) || 'claude'
  );
  const [formData, setFormData] = useState<Record<string, any>>(
    baseModel?.config?.env || {
      model_id: '',
      api_key: '',
      base_url: '',
    }
  );

  // Reset form when switching editing object
  useEffect(() => {
    setModelName(baseModel?.name || '');
    setProvider((baseModel?.config?.env?.model as ProviderType) || 'claude');
    setFormData(
      baseModel?.config?.env || {
        model_id: '',
        api_key: '',
        base_url: '',
      }
    );
    setErrors({});
  }, [editingModelId, baseModel]);

  const handleBack = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      handleBack();
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleBack]);

  const handleFormFieldChange = useCallback((field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: false }));
  }, []);

  const handleProviderChange = useCallback((value: string) => {
    setProvider(value as ProviderType);
    setFormData({
      model_id: '',
      api_key: '',
      base_url: '',
    });
    setErrors({});
  }, []);

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, boolean> = {};

    if (!modelName.trim()) {
      newErrors.name = true;
    }

    if (!formData.model_id?.trim()) {
      newErrors.model_id = true;
    }

    if (!formData.api_key?.trim()) {
      newErrors.api_key = true;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [modelName, formData]);

  const handleTestConnection = async () => {
    if (!validateForm()) {
      toast({
        variant: 'destructive',
        title: t('settings.model.errors.required'),
      });
      return;
    }

    setTestingConnection(true);
    try {
      const result = await modelApis.testConnection({
        provider,
        config: {
          env: {
            model: provider,
            ...formData,
          },
        },
      });

      if (result.success) {
        toast({
          title: t('settings.model.test_success'),
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('settings.model.test_failed') + ': ' + result.message,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('settings.model.test_failed') + ': ' + (error as Error).message,
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSave = async () => {
    if (!validateForm()) {
      toast({
        variant: 'destructive',
        title: t('settings.model.errors.required'),
      });
      return;
    }

    setModelSaving(true);
    try {
      const modelReq: ModelCreateRequest = {
        name: modelName.trim(),
        config: {
          env: {
            model: provider,
            ...formData,
          },
        },
        is_active: true,
      };

      if (editingModelId && editingModelId > 0) {
        // Edit existing model
        const updated = await modelApis.updateModel(editingModelId, modelReq);
        setModels(prev => prev.map(m => (m.id === editingModelId ? updated : m)));
      } else {
        // Create new model
        const created = await modelApis.createModel(modelReq);
        setModels(prev => [created, ...prev]);
      }
      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('settings.model.errors.create_failed'),
      });
    } finally {
      setModelSaving(false);
    }
  };

  const renderProviderForm = () => {
    const props = {
      formData,
      onChange: handleFormFieldChange,
      errors,
    };

    switch (provider) {
      case 'claude':
        return <ClaudeModelForm {...props} />;
      case 'openai':
        return <OpenAIModelForm {...props} />;
      case 'openrouter':
        return <OpenRouterModelForm {...props} />;
      case 'deepseek':
        return <DeepSeekModelForm {...props} />;
      case 'glm':
        return <GLMModelForm {...props} />;
      case 'qwen':
        return <QwenModelForm {...props} />;
      default:
        return <OpenAIModelForm {...props} />;
    }
  };

  return (
    <div className="flex flex-col w-full bg-surface rounded-lg px-2 py-4 min-h-[650px] overflow-hidden">
      {/* Top navigation bar */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mr-1"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          <Button onClick={handleTestConnection} disabled={testingConnection} variant="secondary">
            {testingConnection && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {testingConnection ? t('settings.model.testing') : t('settings.model.test_connection')}
          </Button>
          <Button onClick={handleSave} disabled={modelSaving}>
            {modelSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {modelSaving ? t('actions.saving') : t('actions.save')}
          </Button>
        </div>
      </div>

      {/* Main content area - responsive layout */}
      <div className="flex flex-col lg:flex-row gap-4 flex-grow mx-2 min-h-0 overflow-hidden">
        <div className="flex flex-col space-y-3 overflow-y-auto w-full lg:w-2/5 xl:w-1/3 flex-shrink-0">
          {/* Model Name */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('settings.model.name')} <span className="text-red-400">*</span>
              </label>
            </div>
            <input
              type="text"
              value={modelName}
              onChange={e => {
                setModelName(e.target.value);
                setErrors(prev => ({ ...prev, name: false }));
              }}
              placeholder={t('settings.model.name_placeholder')}
              className={`w-full px-4 py-1 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 text-base ${
                errors.name
                  ? 'border border-red-400 focus:ring-red-300'
                  : 'border border-transparent focus:ring-primary/40'
              }`}
            />
          </div>

          {/* Provider */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('settings.model.provider')} <span className="text-red-400">*</span>
              </label>
            </div>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('settings.model.provider_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">{t('settings.model.providers.claude')}</SelectItem>
                <SelectItem value="openai">{t('settings.model.providers.openai')}</SelectItem>
                <SelectItem value="openrouter">
                  {t('settings.model.providers.openrouter')}
                </SelectItem>
                <SelectItem value="deepseek">{t('settings.model.providers.deepseek')}</SelectItem>
                <SelectItem value="glm">{t('settings.model.providers.glm')}</SelectItem>
                <SelectItem value="qwen">{t('settings.model.providers.qwen')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Provider-specific form */}
          {renderProviderForm()}
        </div>

        {/* Right help area */}
        <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col min-h-0">
          <div className="mb-1 flex-shrink-0">
            <div className="flex items-center">
              <label className="block text-base font-medium text-text-primary">
                {t('settings.model.help_title') || 'Configuration Help'}
              </label>
            </div>
          </div>

          <div className="w-full h-full px-4 py-2 bg-base rounded-md text-text-muted text-sm resize-none min-h-[200px] flex-grow overflow-y-auto">
            <p className="mb-2">
              {t('settings.model.help_description') ||
                'Fill in the configuration fields for your selected provider. Test the connection before saving to ensure your credentials are valid.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelEdit;
