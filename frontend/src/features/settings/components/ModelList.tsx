// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import {
  CpuChipIcon,
  PencilIcon,
  TrashIcon,
  BeakerIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline';
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
import { modelApis, ModelCRD, PublicModelItem } from '@/apis/models';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';

// Unified display model interface
interface DisplayModel {
  name: string; // Unique identifier (ID)
  displayName: string; // Human-readable name (falls back to name if not set)
  modelType: string;
  modelId: string;
  isPublic: boolean;
  originalData: ModelCRD | null;
}

const ModelList: React.FC = () => {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [userModels, setUserModels] = useState<ModelCRD[]>([]);
  const [publicModels, setPublicModels] = useState<PublicModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingModel, setEditingModel] = useState<ModelCRD | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<ModelCRD | null>(null);
  const [testingModelName, setTestingModelName] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch both user models and public models in parallel
      const [userResponse, publicResponse] = await Promise.all([
        modelApis.getAllModels(),
        modelApis.getPublicModels(),
      ]);
      setUserModels(userResponse.items || []);
      setPublicModels(publicResponse.items || []);
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

  // Convert to unified display format
  // Convert to unified display format
  const displayModels: DisplayModel[] = React.useMemo(() => {
    const result: DisplayModel[] = [];

    // Add public models first
    for (const pm of publicModels) {
      const env = pm.config?.env || {};
      result.push({
        name: pm.name,
        displayName: pm.name, // Public models use name as display name
        modelType: env.model || 'claude',
        modelId: env.model_id || '',
        isPublic: true,
        originalData: null,
      });
    }

    // Add user models (exclude those with same name as public models)
    const publicNames = new Set(publicModels.map(pm => pm.name));
    for (const model of userModels) {
      if (!publicNames.has(model.metadata.name)) {
        const env = model.spec.modelConfig?.env || {};
        result.push({
          name: model.metadata.name,
          displayName: model.metadata.displayName || model.metadata.name, // Use displayName if available, fallback to name
          modelType: env.model || 'claude',
          modelId: env.model_id || '',
          isPublic: false,
          originalData: model,
        });
      }
    }

    return result;
  }, [userModels, publicModels]);
  const handleTestConnection = async (displayModel: DisplayModel) => {
    if (displayModel.isPublic || !displayModel.originalData) {
      // Public models cannot be tested (no API key access)
      return;
    }

    const model = displayModel.originalData;
    setTestingModelName(model.metadata.name);
    try {
      const env = model.spec.modelConfig?.env || {};
      const apiKey = env.api_key;
      // If api_key is masked (***) or empty, use model_name to load from database
      const result = await modelApis.testConnection({
        provider_type: env.model === 'openai' ? 'openai' : 'anthropic',
        model_id: env.model_id || '',
        ...(apiKey && apiKey !== '***' ? { api_key: apiKey } : { model_name: model.metadata.name }),
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

  const getProviderLabel = (modelType: string) => {
    return modelType === 'openai' ? 'OpenAI' : 'Anthropic';
  };

  if (editingModel || isCreating) {
    return <ModelEdit model={editingModel} onClose={handleEditClose} toast={toast} />;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('models.title')}</h2>
        <p className="text-sm text-text-muted mb-1">{t('models.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && displayModels.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('models.no_models')}</p>
            <p className="text-sm text-text-muted mt-1">{t('models.no_models_hint')}</p>
          </div>
        )}

        {/* Model List */}
        {!loading && displayModels.length > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
              {displayModels.map(displayModel => {
                return (
                  <Card
                    key={`${displayModel.isPublic ? 'public' : 'user'}-${displayModel.name}`}
                    className={`p-4 bg-base hover:bg-hover transition-colors ${displayModel.isPublic ? 'border-l-2 border-l-primary' : ''}`}
                  >
                    <div className="flex items-center justify-between min-w-0">
                      <div className="flex items-center space-x-3 min-w-0 flex-1">
                        {displayModel.isPublic ? (
                          <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                        ) : (
                          <CpuChipIcon className="w-5 h-5 text-primary flex-shrink-0" />
                        )}
                        <div className="flex flex-col justify-center min-w-0 flex-1">
                          <div className="flex items-center space-x-2 min-w-0">
                            <h3 className="text-base font-medium text-text-primary mb-0 truncate">
                              {displayModel.displayName}
                            </h3>
                            {displayModel.isPublic && (
                              <Tag variant="info" className="text-xs">
                                {t('models.public')}
                              </Tag>
                            )}
                          </div>
                          {/* Show ID if different from display name */}
                          {!displayModel.isPublic &&
                            displayModel.displayName !== displayModel.name && (
                              <p className="text-xs text-text-muted truncate">
                                ID: {displayModel.name}
                              </p>
                            )}
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
                            <Tag variant="default" className="capitalize">
                              {getProviderLabel(displayModel.modelType)}
                            </Tag>
                            <Tag variant="info" className="hidden sm:inline-flex">
                              {displayModel.modelId}
                            </Tag>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                        {/* Only show action buttons for user's own models */}
                        {!displayModel.isPublic && displayModel.originalData && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleTestConnection(displayModel)}
                              disabled={testingModelName === displayModel.name}
                              title={t('models.test_connection')}
                            >
                              {testingModelName === displayModel.name ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <BeakerIcon className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setEditingModel(displayModel.originalData)}
                              title={t('models.edit')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hover:text-error"
                              onClick={() => setDeleteConfirmModel(displayModel.originalData)}
                              title={t('models.delete')}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setIsCreating(true)}>
                {t('models.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

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
