// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PlusIcon, TrashIcon, PencilIcon } from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  adminApis,
  ChatSloganConfig,
  ChatTipItem,
  ChatSloganTipsResponse,
  TipMode,
} from '@/apis/admin';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SystemConfigPanel: React.FC = () => {
  const { t } = useTranslation('admin');
  const { toast } = useToast();

  // State
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [slogan, setSlogan] = useState<ChatSloganConfig>({ zh: '', en: '' });
  const [tips, setTips] = useState<ChatTipItem[]>([]);
  const [version, setVersion] = useState(0);

  // Dialog states
  const [isEditTipDialogOpen, setIsEditTipDialogOpen] = useState(false);
  const [isDeleteTipDialogOpen, setIsDeleteTipDialogOpen] = useState(false);
  const [editingTip, setEditingTip] = useState<ChatTipItem | null>(null);
  const [editingTipIndex, setEditingTipIndex] = useState<number>(-1);
  const [tipFormData, setTipFormData] = useState<Omit<ChatTipItem, 'id'>>({
    zh: '',
    en: '',
    mode: 'both',
  });

  // Fetch config
  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const response: ChatSloganTipsResponse = await adminApis.getSloganTipsConfig();
      setSlogan(response.slogan);
      setTips(response.tips);
      setVersion(response.version);
    } catch (error) {
      console.error('Failed to fetch slogan tips config:', error);
      toast({
        title: t('system_config.errors.load_failed'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Save config
  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await adminApis.updateSloganTipsConfig({
        slogan,
        tips,
      });
      setVersion(response.version);
      toast({
        title: t('system_config.success.updated'),
      });
    } catch (error) {
      console.error('Failed to save slogan tips config:', error);
      toast({
        title: t('system_config.errors.save_failed'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  // Add new tip
  // Add new tip
  const handleAddTip = () => {
    setEditingTip(null);
    setEditingTipIndex(-1);
    setTipFormData({ zh: '', en: '', mode: 'both' });
    setIsEditTipDialogOpen(true);
  };

  // Edit tip
  const handleEditTip = (tip: ChatTipItem, index: number) => {
    setEditingTip(tip);
    setEditingTipIndex(index);
    setTipFormData({ zh: tip.zh, en: tip.en, mode: tip.mode || 'both' });
    setIsEditTipDialogOpen(true);
  };
  // Save tip (add or edit)
  const handleSaveTip = () => {
    if (!tipFormData.zh.trim() || !tipFormData.en.trim()) {
      toast({
        title: t('system_config.errors.tip_required'),
        variant: 'destructive',
      });
      return;
    }

    if (editingTip && editingTipIndex >= 0) {
      // Edit existing tip
      const newTips = [...tips];
      newTips[editingTipIndex] = {
        ...editingTip,
        zh: tipFormData.zh,
        en: tipFormData.en,
        mode: tipFormData.mode,
      };
      setTips(newTips);
    } else {
      // Add new tip
      const newId = tips.length > 0 ? Math.max(...tips.map(t => t.id)) + 1 : 1;
      setTips([
        ...tips,
        { id: newId, zh: tipFormData.zh, en: tipFormData.en, mode: tipFormData.mode },
      ]);
    }

    setIsEditTipDialogOpen(false);
    setEditingTip(null);
    setEditingTipIndex(-1);
  };

  // Delete tip confirmation
  const handleDeleteTipClick = (tip: ChatTipItem, index: number) => {
    setEditingTip(tip);
    setEditingTipIndex(index);
    setIsDeleteTipDialogOpen(true);
  };

  // Confirm delete tip
  const handleConfirmDeleteTip = () => {
    if (editingTipIndex >= 0) {
      const newTips = tips.filter((_, i) => i !== editingTipIndex);
      setTips(newTips);
    }
    setIsDeleteTipDialogOpen(false);
    setEditingTip(null);
    setEditingTipIndex(-1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-text-muted">{t('system_config.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{t('system_config.title')}</h2>
          <p className="text-sm text-text-muted">{t('system_config.description')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>

      {/* Slogan Configuration */}
      <Card className="p-6">
        <h3 className="text-md font-medium text-text-primary mb-4">
          {t('system_config.slogan_title')}
        </h3>
        <div className="space-y-4">
          <div>
            <Label htmlFor="slogan-zh">{t('system_config.slogan_zh')}</Label>
            <Input
              id="slogan-zh"
              value={slogan.zh}
              onChange={e => setSlogan({ ...slogan, zh: e.target.value })}
              placeholder={t('system_config.slogan_zh_placeholder')}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="slogan-en">{t('system_config.slogan_en')}</Label>
            <Input
              id="slogan-en"
              value={slogan.en}
              onChange={e => setSlogan({ ...slogan, en: e.target.value })}
              placeholder={t('system_config.slogan_en_placeholder')}
              className="mt-1"
            />
          </div>
        </div>
      </Card>

      {/* Tips Configuration */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-text-primary">{t('system_config.tips_title')}</h3>
          <Button variant="outline" size="sm" onClick={handleAddTip}>
            <PlusIcon className="h-4 w-4 mr-1" />
            {t('system_config.add_tip')}
          </Button>
        </div>

        {tips.length === 0 ? (
          <div className="text-center py-8 text-text-muted">{t('system_config.no_tips')}</div>
        ) : (
          <div className="space-y-3">
            {tips.map((tip, index) => (
              <div
                key={tip.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-surface border border-border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-text-primary truncate flex-1">{tip.zh}</p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary flex-shrink-0">
                      {t(`system_config.tip_mode_${tip.mode || 'both'}`)}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted truncate mt-1">{tip.en}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleEditTip(tip, index)}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-600"
                    onClick={() => handleDeleteTipClick(tip, index)}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Version Info */}
      <div className="text-xs text-text-muted text-right">
        {t('system_config.version')}: {version}
      </div>

      {/* Edit Tip Dialog */}
      <Dialog open={isEditTipDialogOpen} onOpenChange={setIsEditTipDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingTip ? t('system_config.edit_tip') : t('system_config.add_tip')}
            </DialogTitle>
            <DialogDescription>{t('system_config.tip_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="tip-zh">{t('system_config.tip_zh')}</Label>
              <Textarea
                id="tip-zh"
                value={tipFormData.zh}
                onChange={e => setTipFormData({ ...tipFormData, zh: e.target.value })}
                placeholder={t('system_config.tip_zh_placeholder')}
                className="mt-1"
                rows={2}
              />
            </div>
            <div>
              <Label htmlFor="tip-en">{t('system_config.tip_en')}</Label>
              <Textarea
                id="tip-en"
                value={tipFormData.en}
                onChange={e => setTipFormData({ ...tipFormData, en: e.target.value })}
                placeholder={t('system_config.tip_en_placeholder')}
                className="mt-1"
                rows={2}
              />
            </div>
            <div>
              <Label htmlFor="tip-mode">{t('system_config.tip_mode')}</Label>
              <Select
                value={tipFormData.mode || 'both'}
                onValueChange={(value: TipMode) => setTipFormData({ ...tipFormData, mode: value })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={t('system_config.tip_mode')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">{t('system_config.tip_mode_chat')}</SelectItem>
                  <SelectItem value="code">{t('system_config.tip_mode_code')}</SelectItem>
                  <SelectItem value="both">{t('system_config.tip_mode_both')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditTipDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveTip}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Tip Confirmation Dialog */}
      <AlertDialog open={isDeleteTipDialogOpen} onOpenChange={setIsDeleteTipDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('system_config.delete_tip_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('system_config.delete_tip_message')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteTip}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SystemConfigPanel;
