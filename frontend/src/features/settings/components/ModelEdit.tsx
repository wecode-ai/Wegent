// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import { modelApis, type ModelCRD } from '@/apis/models';

interface ModelEditProps {
  editingModel?: ModelCRD | null;
  onSuccess: () => void;
  onCancel: () => void;
}

const formSchema = z.object({
  name: z
    .string()
    .min(2, 'Model name must be at least 2 characters')
    .max(50, 'Model name must be less than 50 characters')
    .regex(/^[a-z0-9-]+$/, 'Model name can only contain lowercase letters, numbers, and hyphens'),
  provider_type: z.enum(['openai', 'anthropic']),
  model_id: z.string().min(1, 'Model ID is required'),
  api_key: z.string().min(1, 'API Key is required'),
  base_url: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

const MODEL_PRESETS = {
  openai: [
    { value: 'gpt-4o', label: 'gpt-4o', recommended: true },
    { value: 'gpt-4-turbo', label: 'gpt-4-turbo', recommended: false },
    { value: 'gpt-4', label: 'gpt-4', recommended: false },
    { value: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo', recommended: false },
    { value: 'custom', label: 'Custom', recommended: false },
  ],
  anthropic: [
    { value: 'claude-sonnet-4', label: 'claude-sonnet-4', recommended: true },
    { value: 'claude-opus-4', label: 'claude-opus-4', recommended: false },
    { value: 'claude-haiku-4.5', label: 'claude-haiku-4.5', recommended: false },
    { value: 'custom', label: 'Custom', recommended: false },
  ],
};

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const API_KEY_PLACEHOLDERS = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

export default function ModelEdit({ editingModel, onSuccess, onCancel }: ModelEditProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [showApiKey, setShowApiKey] = useState(false);
  const [isCustomModelId, setIsCustomModelId] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      provider_type: 'openai',
      model_id: '',
      api_key: '',
      base_url: '',
    },
  });

  const watchProviderType = form.watch('provider_type');
  const watchModelId = form.watch('model_id');

  // Initialize form when editing
  useEffect(() => {
    if (editingModel) {
      const providerType =
        editingModel.spec.modelConfig.env.model === 'openai' ? 'openai' : 'anthropic';
      const modelId = editingModel.spec.modelConfig.env.model_id;

      // Check if model_id is a preset
      const presets = MODEL_PRESETS[providerType];
      const isPreset = presets.some(preset => preset.value === modelId);

      form.reset({
        name: editingModel.metadata.name,
        provider_type: providerType,
        model_id: isPreset ? modelId : 'custom',
        api_key: editingModel.spec.modelConfig.env.api_key,
        base_url: editingModel.spec.modelConfig.env.base_url || '',
      });

      setIsCustomModelId(!isPreset);
    }
  }, [editingModel, form]);

  // Update base URL when provider type changes
  useEffect(() => {
    if (!editingModel) {
      form.setValue('base_url', DEFAULT_BASE_URLS[watchProviderType]);
    }
  }, [watchProviderType, editingModel, form]);

  // Handle model ID changes
  useEffect(() => {
    if (watchModelId === 'custom') {
      setIsCustomModelId(true);
      form.setValue('model_id', '');
    } else if (watchModelId) {
      setIsCustomModelId(false);
    }
  }, [watchModelId, form]);

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    try {
      const modelCRD: ModelCRD = {
        metadata: {
          name: values.name,
          namespace: 'default',
        },
        spec: {
          modelConfig: {
            env: {
              model: values.provider_type === 'openai' ? 'openai' : 'claude',
              model_id: values.model_id,
              api_key: values.api_key,
              base_url: values.base_url || undefined,
            },
          },
        },
        status: {
          state: 'active',
        },
      };

      if (editingModel) {
        await modelApis.updateModel(editingModel.metadata.name, modelCRD);
        toast({
          title: t('models.edit'),
          description: 'Model updated successfully',
        });
      } else {
        await modelApis.createModel(modelCRD);
        toast({
          title: t('models.create'),
          description: 'Model created successfully',
        });
      }

      onSuccess();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: editingModel ? t('models.errors.update_failed') : t('models.errors.create_failed'),
        description: (error as Error)?.message || 'An error occurred',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Model Name */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t('models.name')} <span className="text-red-400">*</span>
              </FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="my-model"
                  disabled={!!editingModel}
                  className="bg-base"
                />
              </FormControl>
              <FormDescription className="text-xs text-text-muted">
                Lowercase letters, numbers, and hyphens only
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Provider Type */}
        <FormField
          control={form.control}
          name="provider_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t('models.provider_type')} <span className="text-red-400">*</span>
              </FormLabel>
              <Select
                onValueChange={value => {
                  field.onChange(value);
                  // Reset model_id when provider changes
                  form.setValue('model_id', '');
                  setIsCustomModelId(false);
                }}
                value={field.value}
              >
                <FormControl>
                  <SelectTrigger className="bg-base">
                    <SelectValue placeholder={t('models.select_provider')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription className="text-xs text-text-muted">
                {t('models.provider_hint')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Model ID */}
        <FormField
          control={form.control}
          name="model_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t('models.model_id')} <span className="text-red-400">*</span>
              </FormLabel>
              {isCustomModelId ? (
                <FormControl>
                  <Input
                    {...field}
                    placeholder={
                      watchProviderType === 'openai'
                        ? 'gpt-4o-2024-05-13'
                        : 'claude-3-5-sonnet-20241022'
                    }
                    className="bg-base"
                  />
                </FormControl>
              ) : (
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger className="bg-base">
                      <SelectValue placeholder={t('models.select_model_id')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {MODEL_PRESETS[watchProviderType].map(preset => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                        {preset.recommended && (
                          <span className="ml-2 text-xs text-primary">(recommended)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* API Key */}
        <FormField
          control={form.control}
          name="api_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t('models.api_key')} <span className="text-red-400">*</span>
              </FormLabel>
              <FormControl>
                <div className="relative">
                  <Input
                    {...field}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={API_KEY_PLACEHOLDERS[watchProviderType]}
                    className="bg-base pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                  >
                    {showApiKey ? (
                      <EyeSlashIcon className="w-4 h-4" />
                    ) : (
                      <EyeIcon className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Base URL */}
        <FormField
          control={form.control}
          name="base_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('models.base_url')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder={DEFAULT_BASE_URLS[watchProviderType]}
                  className="bg-base"
                />
              </FormControl>
              <FormDescription className="text-xs text-text-muted">
                {t('models.base_url_hint')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Actions */}
        <div className="flex gap-3 pt-4">
          <Button type="submit" disabled={isSubmitting} className="flex-1">
            {isSubmitting ? t('actions.saving') : t('actions.save')}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
            {t('actions.cancel')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
