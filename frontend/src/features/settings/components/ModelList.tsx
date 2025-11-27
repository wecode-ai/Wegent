// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CpuChipIcon, PencilIcon, TrashIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import ModelEdit from './ModelEdit';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { modelApis, ModelCRD } from '@/apis/models';

const ModelList: React.FC = () => {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [models, setModels] = useState<ModelCRD[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingModel, setEditingModel] = useState<ModelCRD | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<ModelCRD | null>(null);
  const [testingModelName, setTestingModelName] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await modelApis.getAllModels();
      setModels(response.items || []);
    } catch (error) {
      console.error('Failed to fetch models:', error);
      toast({
        variant: 'destructive',
        title: t('models.errors.load_models_failed'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleTestConnection = async (model: ModelCRD) => {
    setTestingModelName(model.metadata.name);
    try {
      const env = model.spec.modelConfig?.env || {};
      const result = await modelApis.testConnection({
        provider_type: env.model === 'openai' ? 'openai' : 'anthropic',
        model_id: env.model_id || '',
        api_key: env.api_key || '',
        base_url: env.base_url,
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
      setTestingModelName(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmModel) return;

    try {
      await modelApis.deleteModel(deleteConfirmModel.metadata.name);
      toast({
        title: t('models.delete_success'),
      });
      setDeleteConfirmModel(null);
      fetchModels();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('models.errors.delete_failed'),
        description: (error as Error).message,
      });
    }
  };

  const handleEditClose = () => {
    setEditingModel(null);
    setIsCreating(false);
    fetchModels();
  };

  const getProviderStyle = (modelType: string) => {
    if (modelType === 'openai') {
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    }
    return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
  };

  const getProviderLabel = (modelType: string) => {
    return modelType === 'openai' ? 'OpenAI' : 'Anthropic';
  };

  if (editingModel || isCreating) {
    return (
      <ModelEdit
        model={editingModel}
        onClose={handleEditClose}
        toast={toast}
      />
    );
  }

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('models.title')}</h2>
          <p className="text-sm text-text-muted">{t('models.description')}</p>
        </div>
        <Button onClick={() => setIsCreating(true)}>
          {t('models.create')}
        </Button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      )}

      {/* Empty State */}
      {!loading && models.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
          <p className="text-text-muted">{t('models.no_models')}</p>
          <p className="text-sm text-text-muted mt-1">{t('models.no_models_hint')}</p>
        </div>
      )}

      {/* Model List */}
      {!loading && models.length > 0 && (
        <div className="space-y-3 p-1">
          {models.map((model) => {
            const env = model.spec.modelConfig?.env || {};
            const modelType = env.model || 'claude';
            const modelId = env.model_id || '';

            return (
              <Card
                key={model.metadata.name}
                className="p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <CpuChipIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-medium truncate">
                        {model.metadata.name}
                      </h3>
                      <div className="flex gap-1.5 mt-2">
                        <span
                          className={`px-2 py-0.5 text-xs rounded-md ${getProviderStyle(modelType)}`}
                        >
                          {getProviderLabel(modelType)}
                        </span>
                        <span className="px-2 py-0.5 text-xs rounded-md bg-muted text-text-secondary">
                          {modelId}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleTestConnection(model)}
                      disabled={testingModelName === model.metadata.name}
                      title={t('models.test_connection')}
                    >
                      {testingModelName === model.metadata.name ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <BeakerIcon className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditingModel(model)}
                      title={t('models.edit')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-error hover:text-error"
                      onClick={() => setDeleteConfirmModel(model)}
                      title={t('models.delete')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmModel} onOpenChange={() => setDeleteConfirmModel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('models.delete_confirm_message', { name: deleteConfirmModel?.metadata.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-error hover:bg-error/90">
              {t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ModelList;
