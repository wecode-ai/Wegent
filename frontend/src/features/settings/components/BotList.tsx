// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { RiRobot2Line } from 'react-icons/ri';
import LoadingState from '@/features/common/LoadingState';
import { Bot } from '@/types/api';
import { fetchBotsList, deleteBot, isPredefinedModel, getModelFromConfig } from '../services/bots';
import BotEdit from './BotEdit';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import { useTranslation } from '@/hooks/useTranslation';
import { sortBotsByUpdatedAt } from '@/utils/bot';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ResourceListItem } from '@/components/common/ResourceListItem';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

export default function BotList() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [bots, setBots] = useState<Bot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [cloningBot, setCloningBot] = useState<Bot | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [botToDelete, setBotToDelete] = useState<number | null>(null);
  const isEditing = editingBotId !== null;

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>(
    updater => {
      setBots(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Bot[]) => Bot[])(prev) : updater;
        return sortBotsByUpdatedAt(next);
      });
    },
    [setBots]
  );

  useEffect(() => {
    async function loadBots() {
      setIsLoading(true);
      try {
        const botsData = await fetchBotsList();
        setBotsSorted(botsData);
      } catch {
        toast({
          variant: 'destructive',
          title: t('bots.loading'),
        });
      } finally {
        setIsLoading(false);
      }
    }
    loadBots();
  }, [toast, setBotsSorted, t]);

  const handleCreateBot = () => {
    setCloningBot(null);
    setEditingBotId(0); // Use 0 to mark new creation
  };

  const handleEditBot = (bot: Bot) => {
    setCloningBot(null);
    setEditingBotId(bot.id);
  };

  const handleCloneBot = (bot: Bot) => {
    setCloningBot(bot);
    setEditingBotId(0);
  };

  const handleCloseEditor = () => {
    setEditingBotId(null);
    setCloningBot(null);
  };

  const handleDeleteBot = (botId: number) => {
    setBotToDelete(botId);
    setDeleteConfirmVisible(true);
  };

  const handleConfirmDelete = async () => {
    if (!botToDelete) return;

    try {
      await deleteBot(botToDelete);
      setBotsSorted(prev => prev.filter(b => b.id !== botToDelete));
      setDeleteConfirmVisible(false);
      setBotToDelete(null);
    } catch (e) {
      const errorMessage = e instanceof Error && e.message ? e.message : t('bots.delete');
      toast({
        variant: 'destructive',
        title: errorMessage,
      });
    }
  };

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false);
    setBotToDelete(null);
  };

  return (
    <>
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('bots.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('bots.description')}</p>
        </div>
        <div
          className={`bg-base border border-border rounded-md p-2 w-full ${
            isEditing
              ? 'md:min-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
              : 'max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar'
          }`}
        >
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('bots.loading')} />
          ) : (
            <>
              {/* Edit/New mode */}
              {isEditing ? (
                <BotEdit
                  bots={bots}
                  setBots={setBotsSorted}
                  editingBotId={editingBotId}
                  cloningBot={cloningBot}
                  onClose={handleCloseEditor}
                  toast={toast}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
                    {bots.length > 0 ? (
                      bots.map(bot => (
                        <Card key={bot.id} className="p-4 bg-base hover:bg-hover transition-colors">
                          <div className="flex items-center justify-between min-w-0">
                            <ResourceListItem
                              name={bot.name}
                              icon={<RiRobot2Line className="w-5 h-5 text-primary" />}
                              tags={[
                                {
                                  key: 'shell-type',
                                  label: bot.shell_type,
                                  variant: 'default',
                                  className: 'capitalize',
                                },
                                {
                                  key: 'model',
                                  label: isPredefinedModel(bot.agent_config)
                                    ? getModelFromConfig(bot.agent_config)
                                    : 'CustomModel',
                                  variant: 'info',
                                  className: 'hidden sm:inline-flex capitalize',
                                },
                              ]}
                            >
                              <div className="flex items-center space-x-1 flex-shrink-0">
                                <div
                                  className="w-2 h-2 rounded-full"
                                  style={{
                                    backgroundColor: bot.is_active
                                      ? 'rgb(var(--color-success))'
                                      : 'rgb(var(--color-border))',
                                  }}
                                ></div>
                                <span className="text-xs text-text-muted">
                                  {bot.is_active ? t('bots.active') : t('bots.inactive')}
                                </span>
                              </div>
                            </ResourceListItem>
                            <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditBot(bot)}
                                title={t('bots.edit')}
                                className="h-8 w-8"
                              >
                                <PencilIcon className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleCloneBot(bot)}
                                title={t('bots.copy')}
                                className="h-8 w-8"
                              >
                                <DocumentDuplicateIcon className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteBot(bot?.id)}
                                title={t('bots.delete')}
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
                        <p className="text-sm">{t('bots.no_bots')}</p>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border pt-3 mt-3 bg-base">
                    <div className="flex justify-center">
                      <UnifiedAddButton onClick={handleCreateBot}>
                        {t('bots.new_bot')}
                      </UnifiedAddButton>
                    </div>
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
            <DialogTitle>{t('bots.delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('bots.delete_confirm_message')}</DialogDescription>
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
