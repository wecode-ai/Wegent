// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useTranslation } from 'react-i18next';
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

interface CancelConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Cancel generation confirm dialog component
 * Uses WeCode AlertDialog style with i18n support
 */
export default function CancelConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
}: CancelConfirmDialogProps) {
  const { t } = useTranslation();

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('wiki.cancel_dialog_title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('wiki.cancel_dialog_description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-error hover:bg-error/90 text-white"
          >
            {t('actions.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
