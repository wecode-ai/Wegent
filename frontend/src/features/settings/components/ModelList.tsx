// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import React, { useState, useEffect } from 'react';
import { CpuChipIcon, PencilIcon, TrashIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import { modelApis, type ModelCRD } from '@/apis/models';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import LoadingState from '@/features/common/LoadingState';

interface ModelListProps {
  onEdit: (model: ModelCRD) => void;
  onCreate: () => void;
  onRefresh?: () => void;
}

export default function ModelList({ onEdit, onCreate, onRefresh }: ModelListProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [models, setModels] = useState<ModelCRD[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);

  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadModels = async () => {
    setLoading(true);
    try {
      const modelsData = await modelApis.fetchAllModels();
      setModels(modelsData);
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('models.errors.load_models_failed'),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async (model: ModelCRD) => {
    const modelName = model.metadata.name;
    setTestingModel(modelName);

    try {
      const config = {
        provider_type:
          model.spec.modelConfig.env.model === 'openai'
            ? ('openai' as const)
            : ('anthropic' as const),
        model_id: model.spec.modelConfig.env.model_id,
        api_key: model.spec.modelConfig.env.api_key,
        base_url: model.spec.modelConfig.env.base_url,
      };

      const result = await modelApis.testModelConnection(config);

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
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setTestingModel(null);
    }
  };

  const handleDeleteModel = (modelName: string) => {
    setModelToDelete(modelName);
    setDeleteConfirmVisible(true);
  };

  const handleConfirmDelete = async () => {
    if (!modelToDelete) return;

    try {
      await modelApis.deleteModel(modelToDelete);
      setModels(prev => prev.filter(m => m.metadata.name !== modelToDelete));
      setDeleteConfirmVisible(false);
      setModelToDelete(null);
      toast({
        title: t('models.delete'),
        description: `Model "${modelToDelete}" deleted successfully`,
      });
      onRefresh?.();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('models.errors.delete_failed'),
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false);
    setModelToDelete(null);
  };

  const getProviderVariant = (provider: string): 'default' | 'info' => {
    return provider === 'openai' ? 'info' : 'default';
  };

  const getProviderDisplayName = (provider: string): string => {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'claude') return 'Anthropic';
    return provider;
  };

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('models.title')}</h2>
          <p className="text-sm text-text-muted mb-1">Manage models for your AI assistants</p>
        </div>
        <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
          {loading ? (
            <LoadingState fullScreen={false} message={t('models.loading')} />
          ) : (
            <>
              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
                {models.length > 0 ? (
                  models.map(model => (
                    <Card
                      key={model.metadata.name}
                      className="p-4 bg-base hover:bg-hover transition-colors"
                    >
                      <div className="flex items-center justify-between min-w-0">
                        <div className="flex items-center space-x-3 min-w-0 flex-1">
                          <CpuChipIcon className="w-5 h-5 text-primary flex-shrink-0" />
                          <div className="flex flex-col justify-center min-w-0 flex-1">
                            <h3 className="text-base font-medium text-text-primary mb-0 truncate">
                              {model.metadata.name}
                            </h3>
                            <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
                              <Tag
                                variant={getProviderVariant(model.spec.modelConfig.env.model)}
                                className="capitalize"
                              >
                                {getProviderDisplayName(model.spec.modelConfig.env.model)}
                              </Tag>
                              <Tag variant="default" className="hidden sm:inline-flex">
                                {model.spec.modelConfig.env.model_id}
                              </Tag>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleTestConnection(model)}
                            title={t('models.test_connection')}
                            className="h-8 w-8"
                            disabled={testingModel === model.metadata.name}
                          >
                            <BeakerIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onEdit(model)}
                            title={t('models.edit')}
                            className="h-8 w-8"
                          >
                            <PencilIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteModel(model.metadata.name)}
                            title={t('models.delete')}
                            className="h-8 w-8 hover:text-error"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))
                ) : (
                  <div className="text-center text-text-muted py-8">
                    <p className="text-sm">{t('models.no_models')}</p>
                  </div>
                )}
              </div>
              <div className="border-t border-border pt-3 mt-3 bg-base">
                <div className="flex justify-center">
                  <UnifiedAddButton onClick={onCreate}>{t('models.create')}</UnifiedAddButton>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmVisible} onOpenChange={setDeleteConfirmVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('models.delete')}</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the model &quot;{modelToDelete}&quot;? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
