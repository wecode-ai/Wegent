// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { Plus, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { KnowledgeBaseCard } from './KnowledgeBaseCard';
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog';
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog';
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog';
import { DocumentList } from './DocumentList';
import { useKnowledgeBases } from '../hooks/useKnowledgeBases';
import type { KnowledgeBase, KnowledgeResourceScope } from '@/types/knowledge';
import { useTranslation } from '@/hooks/useTranslation';

interface KnowledgeBaseListProps {
  scope?: KnowledgeResourceScope;
  groupName?: string;
  canManage?: boolean;
}

export function KnowledgeBaseList({
  scope = 'personal',
  groupName,
  canManage = true,
}: KnowledgeBaseListProps) {
  const { t } = useTranslation();
  const { knowledgeBases, loading, error, create, update, remove, refresh } = useKnowledgeBases({
    scope,
    groupName,
  });

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null);
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null);
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null);

  const handleCreate = async (data: {
    name: string;
    description?: string;
    retrieval_config?: Parameters<typeof create>[0]['retrieval_config'];
  }) => {
    try {
      await create({
        name: data.name,
        description: data.description,
        namespace: scope === 'group' && groupName ? groupName : 'default',
        retrieval_config: data.retrieval_config,
      });
      setShowCreateDialog(false);
    } catch {
      // Error handled by hook
    }
  };

  const handleUpdate = async (data: Parameters<typeof update>[1]) => {
    if (!editingKb) return;
    try {
      await update(editingKb.id, data);
      setEditingKb(null);
    } catch {
      // Error handled by hook
    }
  };

  const handleDelete = async () => {
    if (!deletingKb) return;
    try {
      await remove(deletingKb.id);
      setDeletingKb(null);
    } catch {
      // Error handled by hook
    }
  };

  const handleSelectKb = (kb: KnowledgeBase) => {
    setSelectedKb(kb);
  };

  const handleBack = () => {
    setSelectedKb(null);
    refresh();
  };

  // Show document list if a knowledge base is selected
  if (selectedKb) {
    return <DocumentList knowledgeBase={selectedKb} onBack={handleBack} canManage={canManage} />;
  }

  if (loading && knowledgeBases.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
        <p>{error}</p>
        <Button variant="outline" className="mt-4" onClick={refresh}>
          {t('actions.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">
          {scope === 'personal' ? t('knowledge.document.personal') : t('knowledge.document.team')}
        </h2>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-1" />
            {t('knowledge.document.knowledgeBase.create')}
          </Button>
        )}
      </div>

      {/* Knowledge Base Grid */}
      {knowledgeBases.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {knowledgeBases.map(kb => (
            <KnowledgeBaseCard
              key={kb.id}
              knowledgeBase={kb}
              onEdit={setEditingKb}
              onDelete={setDeletingKb}
              onClick={handleSelectKb}
              canManage={canManage}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FolderOpen className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('knowledge.document.knowledgeBase.empty')}</p>
          {canManage && (
            <Button variant="outline" className="mt-4" onClick={() => setShowCreateDialog(true)}>
              <Plus className="w-4 h-4 mr-1" />
              {t('knowledge.document.knowledgeBase.create')}
            </Button>
          )}
        </div>
      )}

      {/* Dialogs */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSubmit={handleCreate}
        loading={loading}
        scope={scope}
        groupName={groupName}
      />

      <EditKnowledgeBaseDialog
        open={!!editingKb}
        onOpenChange={open => !open && setEditingKb(null)}
        knowledgeBase={editingKb}
        onSubmit={handleUpdate}
        loading={loading}
      />

      <DeleteKnowledgeBaseDialog
        open={!!deletingKb}
        onOpenChange={open => !open && setDeletingKb(null)}
        knowledgeBase={deletingKb}
        onConfirm={handleDelete}
        loading={loading}
      />
    </div>
  );
}
