// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { CubeIcon } from '@heroicons/react/24/outline';
import LoadingState from '@/features/common/LoadingState';
import { ModelDetail, modelApis } from '@/apis/models';
import { agentApis } from '@/apis/agents';
import ModelEdit from './ModelEdit';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

export default function ModelList() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [models, setModels] = useState<ModelDetail[]>([]);
  const [filteredModels, setFilteredModels] = useState<ModelDetail[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  const [cloningModel, setCloningModel] = useState<ModelDetail | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [modelToDelete, setModelToDelete] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const isEditing = editingModelId !== null;

  // Load agents
  useEffect(() => {
    async function loadAgents() {
      setLoadingAgents(true);
      try {
        const response = await agentApis.getAgents();
        setAgentNames(response.items.map(agent => agent.name));
      } catch (error) {
        console.error('Failed to fetch agents:', error);
      } finally {
        setLoadingAgents(false);
      }
    }
    loadAgents();
  }, []);

  // Load models
  useEffect(() => {
    async function loadModels() {
      setIsLoading(true);
      try {
        const response = await modelApis.getModels(1, 100);
        setModels(response.items);
        setFilteredModels(response.items);
      } catch (error) {
        toast({
          variant: 'destructive',
          title: t('settings.model.errors.fetch_failed'),
        });
      } finally {
        setIsLoading(false);
      }
    }
    loadModels();
  }, [toast, t]);

  // Filter models by agent
  useEffect(() => {
    if (!selectedAgent) {
      setFilteredModels(models);
      return;
    }

    async function filterByAgent() {
      try {
        const response = await modelApis.getModelNames(selectedAgent);
        const modelNames = response.data.map(m => m.name);

        if (modelNames.length === 0) {
          // If empty array, show all models
          setFilteredModels(models);
        } else {
          // Filter models by name
          const filtered = models.filter(model => modelNames.includes(model.name));
          setFilteredModels(filtered);
        }
      } catch (error) {
        console.error('Failed to filter models:', error);
        setFilteredModels(models);
      }
    }

    filterByAgent();
  }, [selectedAgent, models]);

  const handleCreateModel = () => {
    setCloningModel(null);
    setEditingModelId(0);
  };

  const handleEditModel = (model: ModelDetail) => {
    setCloningModel(null);
    setEditingModelId(model.id);
  };

  const handleCloneModel = (model: ModelDetail) => {
    setCloningModel(model);
    setEditingModelId(0);
  };

  const handleCloseEditor = () => {
    setEditingModelId(null);
    setCloningModel(null);
  };

  const handleDeleteModel = async (modelId: number) => {
    try {
      // Check references first
      const checkResult = await modelApis.checkReferences(modelId);

      if (checkResult.is_referenced) {
        const botNames = checkResult.referenced_by.map(ref => ref.bot_name).join(', ');
        toast({
          variant: 'destructive',
          title: t('settings.model.delete_referenced_error', { bots: botNames }),
        });
        return;
      }

      setModelToDelete(modelId);
      setDeleteConfirmVisible(true);
    } catch (error) {
      console.error('Failed to check references:', error);
      // If check fails, still allow showing the delete dialog
      setModelToDelete(modelId);
      setDeleteConfirmVisible(true);
    }
  };

  const handleConfirmDelete = async () => {
    if (!modelToDelete) return;

    try {
      await modelApis.deleteModel(modelToDelete);
      setModels(prev => prev.filter(m => m.id !== modelToDelete));
      setDeleteConfirmVisible(false);
      setModelToDelete(null);
      toast({
        title: t('settings.model.delete_success') || 'Model deleted successfully',
      });
    } catch (e) {
      const errorMessage = e instanceof Error && e.message ? e.message : t('settings.model.errors.delete_failed');
      toast({
        variant: 'destructive',
        title: errorMessage,
      });
    }
  };

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false);
    setModelToDelete(null);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('settings.model.title')}</h2>
          <p className="text-sm text-text-muted mb-1">
            {t('settings.model.description') || 'Manage your AI model configurations'}
          </p>
        </div>
        <div
          className={`bg-base border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'md:min-h-[70vh] flex items-center justify-center overflow-y-auto custom-scrollbar'
              : 'max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
          }`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('settings.model.loading') || 'Loading models...'} />
          ) : (
            <>
              {/* Edit/New mode */}
              {isEditing ? (
                <ModelEdit
                  models={models}
                  setModels={setModels}
                  editingModelId={editingModelId}
                  cloningModel={cloningModel}
                  onClose={handleCloseEditor}
                  toast={toast}
                />
              ) : (
                <>
                  {/* Filter and Add button */}
                  <div className="flex items-center justify-between gap-2 mb-3 px-1">
                    <div className="flex items-center gap-2 flex-1">
                      <span className="text-sm text-text-muted whitespace-nowrap">
                        {t('settings.model.filter_by_agent')}:
                      </span>
                      <Select
                        value={selectedAgent}
                        onValueChange={setSelectedAgent}
                        disabled={loadingAgents}
                      >
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder={t('settings.model.all_agents') || 'All Agents'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{t('settings.model.all_agents') || 'All Agents'}</SelectItem>
                          {agentNames.map(name => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <UnifiedAddButton onClick={handleCreateModel}>
                      {t('settings.model.create')}
                    </UnifiedAddButton>
                  </div>

                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
                    {filteredModels.length > 0 ? (
                      filteredModels.map(model => (
                        <Card key={model.id} className="p-4 bg-base hover:bg-hover transition-colors">
                          <div className="flex items-center justify-between min-w-0">
                            <div className="flex items-center space-x-3 min-w-0 flex-1">
                              <CubeIcon className="w-5 h-5 text-primary flex-shrink-0" />
                              <div className="flex flex-col justify-center min-w-0 flex-1">
                                <div className="flex items-center space-x-2 min-w-0">
                                  <h3 className="text-base font-medium text-text-primary mb-0 truncate">
                                    {model.name}
                                  </h3>
                                  <div className="flex items-center space-x-1 flex-shrink-0">
                                    <div
                                      className="w-2 h-2 rounded-full"
                                      style={{
                                        backgroundColor: model.is_active
                                          ? 'rgb(var(--color-success))'
                                          : 'rgb(var(--color-border))',
                                      }}
                                    ></div>
                                    <span className="text-xs text-text-muted">
                                      {model.is_active ? t('settings.model.active') || 'Active' : t('settings.model.inactive') || 'Inactive'}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
                                  <Tag variant="default" className="capitalize">
                                    {t(`settings.model.providers.${model.config?.env?.model}`) || model.config?.env?.model}
                                  </Tag>
                                  <Tag variant="info" className="hidden sm:inline-flex text-xs">
                                    {model.config?.env?.model_id}
                                  </Tag>
                                  <span className="text-xs text-text-muted hidden md:inline">
                                    {t('settings.model.updated_at')}: {formatDate(model.updated_at)}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditModel(model)}
                                title={t('settings.model.edit')}
                                className="h-8 w-8"
                              >
                                <PencilIcon className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleCloneModel(model)}
                                title={t('settings.model.copy')}
                                className="h-8 w-8"
                              >
                                <DocumentDuplicateIcon className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteModel(model.id)}
                                title={t('settings.model.delete')}
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
                        <p className="text-sm">{t('settings.model.no_models') || 'No models available'}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmVisible} onOpenChange={setDeleteConfirmVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.model.delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('settings.model.delete_confirm_message')}</DialogDescription>
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
