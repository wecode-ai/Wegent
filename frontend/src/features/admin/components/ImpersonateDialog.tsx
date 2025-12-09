// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tag } from '@/components/ui/tag';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import { impersonationApis } from '@/apis/impersonation';
import { ImpersonationRequest, ImpersonationStatus } from '@/types/impersonation';
import { AdminUser } from '@/apis/admin';
import {
  ClipboardDocumentIcon,
  CheckIcon,
  ArrowPathIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';

interface ImpersonateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  targetUser: AdminUser | null;
}

const ImpersonateDialog: React.FC<ImpersonateDialogProps> = ({ isOpen, onClose, targetUser }) => {
  const { t } = useTranslation('admin');
  const { toast } = useToast();
  const [request, setRequest] = useState<ImpersonationRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remainingTime, setRemainingTime] = useState<string>('');
  const [startingSession, setStartingSession] = useState(false);

  // Create impersonation request when dialog opens
  const createRequest = useCallback(async () => {
    if (!targetUser) return;

    setLoading(true);
    try {
      const newRequest = await impersonationApis.createRequest({
        target_user_id: targetUser.id,
      });
      setRequest(newRequest);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('impersonation.errors.create_failed'),
        description: (error as Error).message,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  }, [targetUser, toast, t, onClose]);

  // Refresh request status
  const refreshStatus = useCallback(async () => {
    if (!request) return;

    try {
      const updatedRequest = await impersonationApis.getRequest(request.id);
      setRequest(updatedRequest);
    } catch (error) {
      console.error('Failed to refresh request status:', error);
    }
  }, [request]);

  // Create request when dialog opens
  useEffect(() => {
    if (isOpen && targetUser) {
      createRequest();
    } else {
      setRequest(null);
      setCopied(false);
    }
  }, [isOpen, targetUser, createRequest]);

  // Poll for status updates when pending
  useEffect(() => {
    if (!request || request.status !== 'pending') return;

    const interval = setInterval(refreshStatus, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, [request, refreshStatus]);

  // Update remaining time countdown
  useEffect(() => {
    if (!request || !request.expires_at) return;

    const updateRemainingTime = () => {
      const now = new Date();
      const expiresAt = new Date(request.expires_at);
      const diff = expiresAt.getTime() - now.getTime();

      if (diff <= 0) {
        setRemainingTime('00:00');
        return;
      }

      const minutes = Math.floor(diff / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setRemainingTime(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
    };

    updateRemainingTime();
    const interval = setInterval(updateRemainingTime, 1000);

    return () => clearInterval(interval);
  }, [request]);

  const handleCopyLink = async () => {
    if (!request?.confirmation_url) return;

    try {
      await navigator.clipboard.writeText(request.confirmation_url);
      setCopied(true);
      toast({ title: t('impersonation.link_copied') });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        variant: 'destructive',
        title: t('impersonation.copy_failed'),
      });
    }
  };

  const handleStartSession = async () => {
    if (!request || request.status !== 'approved') return;

    setStartingSession(true);
    try {
      const response = await impersonationApis.startSession(request.id);
      // Store the impersonation token
      localStorage.setItem('token', response.access_token);
      toast({
        title: t('impersonation.session_started', { name: response.impersonated_user_name }),
      });
      // Reload the page to refresh user context
      window.location.href = '/';
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('impersonation.errors.start_failed'),
        description: (error as Error).message,
      });
    } finally {
      setStartingSession(false);
    }
  };

  const handleCancel = async () => {
    if (!request || request.status !== 'pending') {
      onClose();
      return;
    }

    try {
      await impersonationApis.cancelRequest(request.id);
      toast({ title: t('impersonation.request_cancelled') });
    } catch (error) {
      console.error('Failed to cancel request:', error);
    }
    onClose();
  };

  const getStatusTag = (status: ImpersonationStatus) => {
    const statusConfig: Record<ImpersonationStatus, { variant: 'default' | 'success' | 'error' | 'warning' | 'info'; label: string }> = {
      pending: { variant: 'warning', label: t('impersonation.status.pending') },
      approved: { variant: 'success', label: t('impersonation.status.approved') },
      rejected: { variant: 'error', label: t('impersonation.status.rejected') },
      expired: { variant: 'default', label: t('impersonation.status.expired') },
      used: { variant: 'info', label: t('impersonation.status.used') },
    };

    const config = statusConfig[status];
    return <Tag variant={config.variant}>{config.label}</Tag>;
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && handleCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('impersonation.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('impersonation.dialog.description', { name: targetUser?.user_name })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : request ? (
          <div className="space-y-4 py-4">
            {/* Target User Info */}
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <div>
                <p className="text-sm text-text-muted">{t('impersonation.dialog.target_user')}</p>
                <p className="font-medium">{request.target_user_name}</p>
              </div>
              {getStatusTag(request.status)}
            </div>

            {/* Confirmation Link */}
            {request.status === 'pending' && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('impersonation.dialog.confirmation_link')}
                  </label>
                  <div className="flex gap-2">
                    <Input value={request.confirmation_url} readOnly className="font-mono text-xs" />
                    <Button variant="outline" size="icon" onClick={handleCopyLink}>
                      {copied ? (
                        <CheckIcon className="w-4 h-4 text-success" />
                      ) : (
                        <ClipboardDocumentIcon className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-text-muted">
                    {t('impersonation.dialog.link_instruction')}
                  </p>
                </div>

                {/* Countdown */}
                <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <span className="text-sm">{t('impersonation.dialog.expires_in')}</span>
                  <span className="font-mono font-medium">{remainingTime}</span>
                </div>

                {/* Refresh Button */}
                <div className="flex justify-center">
                  <Button variant="ghost" size="sm" onClick={refreshStatus}>
                    <ArrowPathIcon className="w-4 h-4 mr-2" />
                    {t('impersonation.dialog.refresh_status')}
                  </Button>
                </div>
              </>
            )}

            {/* Approved State */}
            {request.status === 'approved' && (
              <div className="space-y-4">
                <div className="p-3 bg-success/10 text-success rounded-lg text-center">
                  <p className="font-medium">{t('impersonation.dialog.approved_message')}</p>
                  <p className="text-sm mt-1">{t('impersonation.dialog.click_start')}</p>
                </div>
                <Button onClick={handleStartSession} disabled={startingSession} className="w-full">
                  {startingSession ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <PlayIcon className="w-4 h-4 mr-2" />
                  )}
                  {t('impersonation.dialog.start_session')}
                </Button>
              </div>
            )}

            {/* Rejected State */}
            {request.status === 'rejected' && (
              <div className="p-3 bg-error/10 text-error rounded-lg text-center">
                <p className="font-medium">{t('impersonation.dialog.rejected_message')}</p>
              </div>
            )}

            {/* Expired State */}
            {request.status === 'expired' && (
              <div className="p-3 bg-muted rounded-lg text-center">
                <p className="text-text-muted">{t('impersonation.dialog.expired_message')}</p>
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {request?.status === 'pending' ? t('common.cancel') : t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ImpersonateDialog;
