// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { Search, UserPlus, X, Check, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { taskMemberApi } from '@/apis/task-member';
import { useTranslation } from '@/hooks/useTranslation';
import { userApis } from '@/apis/user';

interface User {
  id: number;
  user_name: string;
  email?: string;
  isUnregistered?: boolean; // Mark user as not registered in platform
}

interface AddMembersDialogProps {
  open: boolean;
  onClose: () => void;
  taskId: number;
  taskTitle: string;
  onMembersAdded?: () => void;
  onComplete?: () => void; // Called when the entire flow is completed (after copying link)
}

export function AddMembersDialog({
  open,
  onClose,
  taskId,
  taskTitle,
  onMembersAdded,
  onComplete,
}: AddMembersDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [showInviteLink, setShowInviteLink] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const [unregisteredUsers, setUnregisteredUsers] = useState<string[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Search users with debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        // Call user search API (you need to implement this endpoint)
        const response = await userApis.searchUsers(searchQuery);
        setSearchResults(response.users || []);
      } catch (error) {
        console.error('Failed to search users:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const handleSelectUser = (user: User) => {
    if (!selectedUsers.find(u => u.id === user.id || u.user_name === user.user_name)) {
      setSelectedUsers([...selectedUsers, user]);
    }
    setSearchQuery('');
    setSearchResults([]);
  };

  // Add unregistered user by name
  const handleAddUnregisteredUser = () => {
    const username = searchQuery.trim();
    if (!username) return;

    // Check if already added
    if (selectedUsers.find(u => u.user_name === username)) {
      return;
    }

    // Add as unregistered user (use negative ID to avoid conflicts)
    const unregisteredUser: User = {
      id: -Date.now(),
      user_name: username,
      isUnregistered: true,
    };

    setSelectedUsers([...selectedUsers, unregisteredUser]);
    setSearchQuery('');
  };

  const handleRemoveUser = (userId: number) => {
    setSelectedUsers(selectedUsers.filter(u => u.id !== userId));
  };

  const handleAddMembers = async () => {
    if (selectedUsers.length === 0) return;

    // Separate registered and unregistered users
    const registeredUsers = selectedUsers.filter(u => !u.isUnregistered);
    const unregisteredUsersList = selectedUsers.filter(u => u.isUnregistered);

    // If all users are unregistered, generate invite link immediately
    if (unregisteredUsersList.length > 0 && registeredUsers.length === 0) {
      setIsAdding(true);
      setUnregisteredUsers(unregisteredUsersList.map(u => u.user_name));

      try {
        // Ensure task is converted to group chat before generating link
        try {
          await taskMemberApi.convertToGroupChat(taskId);
          // Trigger callback immediately after conversion to update UI
          onMembersAdded?.();
        } catch (conversionError) {
          console.log('Task conversion for invite link:', conversionError);
        }

        // Generate invite link
        const response = await taskMemberApi.generateInviteLink(taskId, 0);
        setInviteUrl(response.invite_url);
        setShowInviteLink(true);

        toast({
          title: t('chat:groupChat.addMembers.allUnregistered'),
          description: t('chat:groupChat.addMembers.useInviteLink'),
          variant: 'default',
        });
      } catch (error) {
        console.error('Failed to generate invite link:', error);
        toast({
          title: t('chat:groupChat.inviteLink.generateFailed'),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
      } finally {
        setIsAdding(false);
      }
      return;
    }

    setIsAdding(true);
    let successCount = 0;
    let alreadyMemberCount = 0;
    const errors: string[] = [];

    try {
      // First, ensure the task is converted to a group chat
      let wasConverted = false;
      try {
        await taskMemberApi.convertToGroupChat(taskId);
        wasConverted = true;
        // Note: Don't call onMembersAdded here yet - wait until members are added
        // to avoid race condition where UI refreshes before additions complete
      } catch (conversionError) {
        // Ignore conversion errors - task might already be a group chat
        console.log('Task conversion:', conversionError);
      }

      // Add registered members one by one
      for (const user of registeredUsers) {
        try {
          await taskMemberApi.addMember(taskId, user.id);
          successCount++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          // Check if error is "already member"
          if (errorMessage.includes('already') || errorMessage.includes('已经')) {
            alreadyMemberCount++;
          } else {
            errors.push(`${user.user_name}: ${errorMessage}`);
          }
        }
      }

      setAddedCount(successCount);

      // Now that all operations are complete, trigger UI refresh
      // This ensures the member list is accurate when refreshed
      if (wasConverted || successCount > 0) {
        onMembersAdded?.();
      }

      // Show toast messages based on results
      if (successCount > 0) {
        toast({
          title: t('chat:groupChat.addMembers.success', { count: successCount }),
        });
      }

      if (alreadyMemberCount > 0 && successCount === 0 && errors.length === 0) {
        // All users are already members
        toast({
          title: t('chat:groupChat.addMembers.allAlreadyMembers'),
          variant: 'default',
        });
      }

      // If there are unregistered users, auto-generate invite link
      if (unregisteredUsersList.length > 0) {
        setUnregisteredUsers(unregisteredUsersList.map(u => u.user_name));

        // Auto-generate invite link
        try {
          // Ensure task is converted to group chat before generating link
          try {
            await taskMemberApi.convertToGroupChat(taskId);
          } catch (conversionError) {
            // Ignore conversion errors - task might already be a group chat
            console.log('Task conversion for invite link:', conversionError);
          }

          const response = await taskMemberApi.generateInviteLink(taskId, 0);
          setInviteUrl(response.invite_url);
          setShowInviteLink(true);
        } catch (error) {
          console.error('Failed to generate invite link:', error);
          toast({
            title: t('chat:groupChat.inviteLink.generateFailed'),
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          });
          // Still show the invite link view even if link generation failed
          setShowInviteLink(true);
        }
      } else {
        // All registered users processed (successfully added or already members), close dialog
        handleClose();
      }
    } catch (error) {
      toast({
        title: t('chat:groupChat.addMembers.failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    setSearchQuery('');
    setSearchResults([]);
    setSelectedUsers([]);
    setShowInviteLink(false);
    setAddedCount(0);
    setUnregisteredUsers([]);
    setInviteUrl('');
    setCopied(false);
    onClose();
  };

  const handleCopyInviteLink = async () => {
    if (!inviteUrl) return;

    // Try modern clipboard API first
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setCopied(true);
        toast({
          title: t('chat:groupChat.inviteLink.copied'),
        });
        setTimeout(() => {
          handleClose();
          onComplete?.(); // Notify parent that the entire flow is completed
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
        title: t('chat:groupChat.inviteLink.copied'),
      });
      setTimeout(() => {
        handleClose();
        onComplete?.(); // Notify parent that the entire flow is completed
      }, 500);
    } catch (err) {
      console.error('Fallback copy failed: ', err);
      toast({
        title: t('chat:groupChat.inviteLink.copyFailed'),
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat:groupChat.addMembers.title')}</DialogTitle>
          <DialogDescription>
            {showInviteLink
              ? t('chat:groupChat.addMembers.inviteLinkDescription', { count: addedCount })
              : t('chat:groupChat.addMembers.description', { taskTitle })}
          </DialogDescription>
        </DialogHeader>

        {!showInviteLink ? (
          <div className="space-y-4">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
              <Input
                placeholder={t('chat:groupChat.addMembers.searchPlaceholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <ScrollArea className="h-48 border rounded-md">
                <div className="p-2">
                  {searchResults.map(user => (
                    <button
                      key={user.id}
                      onClick={() => handleSelectUser(user)}
                      disabled={selectedUsers.some(u => u.id === user.id)}
                      className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="flex-1 text-left">
                        <div className="font-medium text-sm">{user.user_name}</div>
                        {user.email && <div className="text-xs text-text-muted">{user.email}</div>}
                      </div>
                      {selectedUsers.some(u => u.id === user.id) && (
                        <Check className="h-4 w-4 text-green-500" />
                      )}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}

            {isSearching && (
              <div className="text-center text-sm text-text-muted py-4">
                {t('chat:groupChat.addMembers.searching')}
              </div>
            )}

            {searchQuery && !isSearching && searchResults.length === 0 && (
              <div className="space-y-2">
                <div className="text-center text-sm text-text-muted py-2">
                  {t('chat:groupChat.addMembers.noResults')}
                </div>
                <Button variant="outline" className="w-full" onClick={handleAddUnregisteredUser}>
                  <UserPlus className="h-4 w-4 mr-2" />
                  {t('chat:groupChat.addMembers.addAsUnregistered', { name: searchQuery })}
                </Button>
              </div>
            )}

            {/* Selected Users */}
            {selectedUsers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">
                  {t('chat:groupChat.addMembers.selected', { count: selectedUsers.length })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.map(user => (
                    <Badge
                      key={user.id}
                      variant={user.isUnregistered ? 'warning' : 'secondary'}
                      className="pr-1"
                    >
                      {user.user_name}
                      {user.isUnregistered && (
                        <span className="ml-1 text-xs">
                          ({t('chat:groupChat.addMembers.unregistered')})
                        </span>
                      )}
                      <button
                        onClick={() => handleRemoveUser(user.id)}
                        className="ml-1 hover:bg-accent rounded-full p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Show unregistered users list */}
            {unregisteredUsers.length > 0 && (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <div className="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                  {t('chat:groupChat.addMembers.unregisteredUsersTitle')}
                </div>
                <div className="text-sm text-yellow-700 dark:text-yellow-300 mb-2">
                  {t('chat:groupChat.addMembers.unregisteredUsersDesc', {
                    users: unregisteredUsers.join(', '),
                  })}
                </div>
                <div className="text-xs text-yellow-600 dark:text-yellow-400">
                  {t('chat:groupChat.addMembers.useInviteLink')}
                </div>
              </div>
            )}

            {/* Show added count if any */}
            {addedCount > 0 && (
              <div className="text-sm text-text-secondary">
                {t('chat:groupChat.addMembers.inviteLinkDescription', { count: addedCount })}
              </div>
            )}

            {/* Display invite link with copy button */}
            {inviteUrl && (
              <div className="flex items-center gap-2">
                <Input value={inviteUrl} readOnly className="flex-1 text-sm" />
                <Button variant="outline" size="icon" onClick={handleCopyInviteLink}>
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!showInviteLink ? (
            <>
              <Button variant="outline" onClick={handleClose}>
                {t('chat:common.cancel')}
              </Button>
              <Button onClick={handleAddMembers} disabled={selectedUsers.length === 0 || isAdding}>
                <UserPlus className="h-4 w-4 mr-2" />
                {isAdding
                  ? t('chat:groupChat.addMembers.adding')
                  : t('chat:groupChat.addMembers.add', { count: selectedUsers.length })}
              </Button>
            </>
          ) : (
            <Button onClick={handleClose}>{t('chat:common.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
