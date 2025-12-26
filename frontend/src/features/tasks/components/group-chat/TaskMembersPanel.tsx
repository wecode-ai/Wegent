// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Users, Link, X, Crown, UserPlus, Copy, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/hooks/use-toast';
import { taskMemberApi, TaskMember } from '@/apis/task-member';
import { useTranslation } from '@/hooks/useTranslation';
import { AddMembersDialog } from './AddMembersDialog';
import { cn } from '@/lib/utils';

interface TaskMembersPanelProps {
  open: boolean;
  onClose: () => void;
  taskId: number;
  taskTitle: string;
  currentUserId: number;
  onLeave?: () => void;
  onMembersChanged?: () => void; // Callback when members are added/removed to refresh task detail
}

export function TaskMembersPanel({
  open,
  onClose,
  taskId,
  taskTitle,
  currentUserId,
  onLeave,
  onMembersChanged,
}: TaskMembersPanelProps) {
  const { t } = useTranslation('chat');
  const { toast } = useToast();
  const [members, setMembers] = useState<TaskMember[]>([]);
  const [taskOwnerId, setTaskOwnerId] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [showAddMembersDialog, setShowAddMembersDialog] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  const isOwner = currentUserId === taskOwnerId;

  const fetchMembers = useCallback(async () => {
    if (!open) return;

    setLoading(true);
    try {
      const response = await taskMemberApi.getMembers(taskId);
      setMembers(response.members);
      setTaskOwnerId(response.task_owner_id);
      // DO NOT call onMembersChanged here - it should only be called when members are actually changed
      // Calling it here would trigger refresh every time the panel opens
    } catch (error: unknown) {
      toast({
        title: t('groupChat.members.loadFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [open, taskId, toast, t]); // Removed onMembersChanged from dependencies

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // Reset invite link state when dialog closes
  useEffect(() => {
    if (!open) {
      // Wait for close animation to complete before resetting state
      const timer = setTimeout(() => {
        setInviteUrl(null);
        setCopied(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleRemoveMember = async (userId: number, username: string) => {
    if (!isOwner) return;

    try {
      await taskMemberApi.removeMember(taskId, userId);
      toast({
        title: t('groupChat.members.removeSuccess', { name: username }),
      });
      // Refresh member list and trigger parent refresh
      // Use the same pattern as AddMembersDialog
      fetchMembers();
      onMembersChanged?.();
    } catch (error: unknown) {
      toast({
        title: t('groupChat.members.removeFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const handleLeaveGroupChat = async () => {
    try {
      await taskMemberApi.leaveGroupChat(taskId);
      toast({
        title: t('groupChat.members.leaveSuccess'),
      });
      handleClose();
      // Notify parent component that user has left
      onLeave?.();
    } catch (error: unknown) {
      toast({
        title: t('groupChat.members.leaveFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const handleGenerateInviteLink = async () => {
    setGeneratingLink(true);
    try {
      // First, ensure the task is converted to a group chat
      let wasConverted = false;
      try {
        await taskMemberApi.convertToGroupChat(taskId);
        wasConverted = true;
      } catch (conversionError: unknown) {
        // Ignore conversion errors - task might already be a group chat
        console.log('Task conversion:', conversionError);
      }

      // Generate the invite link with permanent expiration (0 hours)
      const response = await taskMemberApi.generateInviteLink(taskId, 0);
      setInviteUrl(response.invite_url);

      // Trigger UI refresh if task was converted to group chat
      if (wasConverted) {
        onMembersChanged?.();
      }
    } catch (error: unknown) {
      toast({
        title: t('groupChat.inviteLink.generateFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleCopyLink = async () => {
    if (!inviteUrl) return;

    // Try modern clipboard API first
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setCopied(true);
        toast({
          title: t('groupChat.inviteLink.copied'),
        });
        setTimeout(() => {
          setCopied(false);
          handleClose();
        }, 500);
        return;
      } catch (err) {
        console.error('Clipboard API failed: ', err);
      }
    }

    // Fallback for non-HTTPS environments (e.g., HTTP IP:port)
    try {
      const textarea = document.createElement('textarea');
      textarea.value = inviteUrl;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      toast({
        title: t('groupChat.inviteLink.copied'),
      });
      setTimeout(() => {
        setCopied(false);
        handleClose();
      }, 500);
    } catch (err) {
      console.error('Fallback copy failed: ', err);
      toast({
        title: t('groupChat.inviteLink.copyFailed'),
        variant: 'destructive',
      });
    }
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={open => !open && handleClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              {inviteUrl
                ? t('groupChat.members.inviteLink')
                : `${t('groupChat.members.title')} (${members.length})`}
            </DialogTitle>
            <DialogDescription>{taskTitle}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!inviteUrl ? (
              <>
                {/* Action buttons */}
                <div className="flex gap-2">
                  <Button
                    variant="default"
                    className="flex-1"
                    onClick={() => setShowAddMembersDialog(true)}
                  >
                    <UserPlus className="w-4 h-4 mr-2" />
                    {t('groupChat.members.addMembers')}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleGenerateInviteLink}
                    disabled={generatingLink}
                  >
                    <Link className="w-4 h-4 mr-2" />
                    {generatingLink
                      ? t('groupChat.inviteLink.generating')
                      : t('groupChat.members.inviteLink')}
                  </Button>
                </div>

                {/* Member list */}
                {loading ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {members.map(member => (
                      <div
                        key={member.id || `owner-${member.user_id}`}
                        className={cn(
                          'flex items-center justify-between p-3 rounded-lg',
                          'bg-muted hover:bg-muted/80 transition-colors'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {/* Avatar placeholder */}
                          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <span className="text-sm font-medium text-primary">
                              {member.username.charAt(0).toUpperCase()}
                            </span>
                          </div>

                          <div>
                            <div className="flex items-center gap-1">
                              <span className="font-medium text-sm">{member.username}</span>
                              {member.is_owner && <Crown className="w-3 h-3 text-yellow-500" />}
                              {member.user_id === currentUserId && (
                                <span className="text-xs text-text-muted">
                                  ({t('groupChat.members.you')})
                                </span>
                              )}
                            </div>
                            {!member.is_owner && (
                              <p className="text-xs text-text-muted">
                                {t('groupChat.members.invitedBy', {
                                  name: member.inviter_name,
                                })}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Remove button (only for owner, cannot remove self or other owner) */}
                        {isOwner && !member.is_owner && member.user_id !== currentUserId && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-text-muted hover:text-destructive"
                            onClick={() => handleRemoveMember(member.user_id, member.username)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}

                        {/* Leave button (only for non-owner current user) */}
                        {!isOwner && member.user_id === currentUserId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-text-muted hover:text-destructive"
                            onClick={handleLeaveGroupChat}
                          >
                            {t('groupChat.members.leaveGroupChat')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Done button at bottom */}
                <Button variant="outline" onClick={handleClose} className="w-full">
                  {t('actions.done', { ns: 'common' })}
                </Button>
              </>
            ) : (
              <>
                {/* Invite link display */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Input value={inviteUrl} readOnly className="flex-1 text-sm" />
                    <Button variant="outline" size="icon" onClick={handleCopyLink}>
                      {copied ? (
                        <Check className="w-4 h-4 text-green-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>

                  <p className="text-sm text-foreground">
                    {t('groupChat.members.inviteLinkDescription')}
                  </p>

                  <p className="text-xs text-text-muted">
                    {t('groupChat.inviteLink.permanentNote')}
                  </p>
                </div>

                <Button variant="outline" onClick={handleClose} className="w-full">
                  {t('actions.done', { ns: 'common' })}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Members Dialog */}
      <AddMembersDialog
        open={showAddMembersDialog}
        onClose={() => setShowAddMembersDialog(false)}
        taskId={taskId}
        taskTitle={taskTitle}
        onMembersAdded={() => {
          // Refresh member list first
          fetchMembers();
          // Then trigger parent refresh (task list + task detail)
          onMembersChanged?.();
        }}
        onComplete={handleClose}
      />
    </>
  );
}
