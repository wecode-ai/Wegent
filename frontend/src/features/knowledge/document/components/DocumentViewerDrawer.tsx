// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, FileText, Eye, Pencil, Save, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/hooks/use-toast';
import { MarkdownEditor } from './MarkdownEditor';
import { PDFViewer } from './PDFViewer';
import { getDocumentContent, updateDocumentContent } from '@/apis/knowledge';
import type { KnowledgeDocument, DocumentContent } from '@/types/knowledge';
import { useTranslation } from '@/hooks/useTranslation';

interface DocumentViewerDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: KnowledgeDocument | null;
  canManage?: boolean;
  onContentUpdate?: () => void;
}

export function DocumentViewerDrawer({
  open,
  onOpenChange,
  document,
  canManage = true,
  onContentUpdate,
}: DocumentViewerDrawerProps) {
  const { t } = useTranslation('knowledge');

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Load document content when dialog opens
  useEffect(() => {
    if (open && document) {
      loadContent();
    } else {
      // Reset state when closing
      setContent(null);
      setEditMode(false);
      setEditedContent('');
      setHasChanges(false);
      setLastSaved(null);
    }
  }, [open, document?.id]);

  const loadContent = async () => {
    if (!document) return;

    setLoading(true);
    try {
      const data = await getDocumentContent(document.id);
      setContent(data);
      setEditedContent(data.content);
      setLastSaved(new Date(data.updated_at));
    } catch (error) {
      console.error('Failed to load document content:', error);
      toast({
        title: t('document.viewer.load_failed'),
        variant: 'destructive',
      });
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const handleContentChange = useCallback((value: string) => {
    setEditedContent(value);
    setHasChanges(true);
  }, []);

  const handleSave = async () => {
    if (!document || !content || !hasChanges) return;

    setSaving(true);
    try {
      const updatedContent = await updateDocumentContent(document.id, {
        content: editedContent,
      });
      setContent(updatedContent);
      setEditedContent(updatedContent.content);
      setHasChanges(false);
      setLastSaved(new Date());
      toast({
        title: t('document.viewer.saved'),
        variant: 'success',
      });
      onContentUpdate?.();
    } catch (error) {
      console.error('Failed to save document content:', error);
      toast({
        title: t('document.viewer.save_failed'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  // Auto-save with debounce (2 seconds)
  useEffect(() => {
    if (!hasChanges || !editMode) return;

    const timer = setTimeout(() => {
      handleSave();
    }, 2000);

    return () => clearTimeout(timer);
  }, [editedContent, hasChanges, editMode]);

  const toggleEditMode = () => {
    if (editMode && hasChanges) {
      // Save before switching to preview mode
      handleSave();
    }
    setEditMode(!editMode);
  };

  const getFileIcon = () => {
    if (!content) return <FileText className="w-5 h-5 text-primary" />;

    const ext = content.file_extension.toLowerCase();
    if (ext === 'pdf' || ext === '.pdf') {
      return <FileText className="w-5 h-5 text-red-500" />;
    }
    if (ext === 'md' || ext === '.md') {
      return <FileText className="w-5 h-5 text-blue-500" />;
    }
    return <FileText className="w-5 h-5 text-primary" />;
  };

  const formatLastSaved = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleString();
  };

  const isPDF = content?.file_extension?.toLowerCase().replace('.', '') === 'pdf';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="fixed right-0 top-0 bottom-0 left-auto h-screen w-full max-w-[800px] rounded-none border-l border-border bg-base p-0 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right duration-300"
        style={{ transform: 'none', maxHeight: '100vh' }}
      >
        {/* Hidden description for accessibility */}
        <DialogDescription className="sr-only">
          {t('document.viewer.title')}
        </DialogDescription>

        {/* Header */}
        <DialogHeader className="flex flex-row items-center justify-between border-b border-border px-6 py-4 space-y-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {getFileIcon()}
            <DialogTitle className="text-base font-medium text-text-primary truncate">
              {document?.name || t('document.viewer.title')}
            </DialogTitle>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Edit/Preview toggle button - only for editable files */}
            {content?.is_editable && canManage && (
              <Button
                variant="outline"
                size="sm"
                onClick={toggleEditMode}
                className="gap-1.5"
              >
                {editMode ? (
                  <>
                    <Eye className="w-4 h-4" />
                    {t('document.viewer.preview_mode')}
                  </>
                ) : (
                  <>
                    <Pencil className="w-4 h-4" />
                    {t('document.viewer.edit_mode')}
                  </>
                )}
              </Button>
            )}
            {/* Close button */}
            <button
              onClick={() => onOpenChange(false)}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6" style={{ height: 'calc(100vh - 140px)' }}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Spinner />
            </div>
          ) : content ? (
            isPDF ? (
              <PDFViewer content={content.content} />
            ) : content.is_editable && editMode ? (
              <MarkdownEditor
                value={editedContent}
                onChange={handleContentChange}
                readOnly={!canManage}
              />
            ) : (
              <MarkdownEditor value={editedContent} onChange={() => {}} readOnly={true} />
            )
          ) : (
            <div className="flex items-center justify-center h-full text-text-muted">
              {t('document.viewer.loading')}
            </div>
          )}
        </div>

        {/* Footer - only shown when editing */}
        {content?.is_editable && editMode && (
          <div className="border-t border-border px-6 py-3 flex items-center justify-between bg-surface">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              {saving ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{t('document.viewer.saving')}</span>
                </>
              ) : hasChanges ? (
                <span className="text-warning">{t('document.viewer.unsaved')}</span>
              ) : lastSaved ? (
                <span>
                  {t('document.viewer.last_updated')}: {formatLastSaved(lastSaved)}
                </span>
              ) : null}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className="gap-1.5"
            >
              <Save className="w-4 h-4" />
              {saving ? t('document.viewer.saving') : t('document.viewer.save')}
            </Button>
          </div>
        )}

        {/* Info message for non-editable files */}
        {content && !content.is_editable && (
          <div className="border-t border-border px-6 py-3 bg-surface">
            <p className="text-xs text-text-muted">{t('document.viewer.pdf_readonly')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
