// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import Modal from '@/features/common/Modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listGroupMembers,
  addGroupMemberByUsername,
  removeGroupMember,
  updateGroupMemberRole,
  inviteAllUsers,
  leaveGroup,
} from '@/apis/groups';
import { userApis } from '@/apis/user';
import { toast } from 'sonner';
import type { Group, GroupMember, GroupRole } from '@/types/group';
import { UserPlusIcon, LogOutIcon, Search, X, Check } from 'lucide-react';

// User type for search results
interface SearchUser {
  id: number;
  user_name: string;
  email?: string;
}

interface GroupMembersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  group: Group | null;
  currentUserId?: number;
}

export function GroupMembersDialog({
  isOpen,
  onClose,
  onSuccess,
  group,
  currentUserId,
}: GroupMembersDialogProps) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<GroupRole>('Reporter');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const myRole = group?.my_role;
  const isPrivateGroup = group?.visibility === 'private';

  // Permission checks
  // Private groups do not allow adding members
  const canAddMember = (myRole === 'Owner' || myRole === 'Maintainer') && !isPrivateGroup;
  const canRemoveMember = myRole === 'Owner' || myRole === 'Maintainer';
  const canUpdateRole = myRole === 'Owner' || myRole === 'Maintainer';
  const canInviteAll = (myRole === 'Owner' || myRole === 'Maintainer') && !isPrivateGroup;
  const canLeave = myRole !== 'Owner';

  useEffect(() => {
    if (isOpen && group) {
      loadMembers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, group]);

  // Search users with 300ms debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowSearchDropdown(false);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await userApis.searchUsers(searchQuery);
        setSearchResults(response.users || []);
        setShowSearchDropdown(true);
      } catch (error) {
        console.error('Failed to search users:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setShowSearchDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const loadMembers = async () => {
    if (!group) return;

    setLoading(true);
    try {
      const response = await listGroupMembers(group.name);
      // Backend returns array directly, not wrapped in {items: []}
      const membersList = Array.isArray(response) ? response : response.items || [];
      setMembers(membersList);
    } catch (error) {
      console.error('Failed to load members:', error);
      toast.error(t('groups:groupMembers.loadMembersFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Handle selecting a user from search results
  const handleSelectUser = (user: SearchUser) => {
    // Check if already selected
    if (!selectedUsers.find(u => u.id === user.id)) {
      setSelectedUsers([...selectedUsers, user]);
    }
    setSearchQuery('');
    setSearchResults([]);
    setShowSearchDropdown(false);
  };

  // Handle removing a selected user
  const handleRemoveSelectedUser = (userId: number) => {
    setSelectedUsers(selectedUsers.filter(u => u.id !== userId));
  };

  const handleAddMembers = async () => {
    if (!group || selectedUsers.length === 0) return;

    setIsSubmitting(true);
    let successCount = 0;
    let alreadyMemberCount = 0;
    const errors: string[] = [];

    try {
      for (const user of selectedUsers) {
        // Check if user already exists in members
        const existingMember = members.find(m => m.user_name === user.user_name);
        if (existingMember) {
          alreadyMemberCount++;
          continue;
        }

        try {
          const result = await addGroupMemberByUsername(group.name, user.user_name, selectedRole);
          if (result.success) {
            successCount++;
          } else {
            errors.push(
              `${user.user_name}: ${result.message || t('groups:groupMembers.addMemberFailed')}`
            );
          }
        } catch (error: unknown) {
          const err = error as { message?: string };
          errors.push(
            `${user.user_name}: ${err?.message || t('groups:groupMembers.addMemberFailed')}`
          );
        }
      }

      // Show results
      if (successCount > 0) {
        toast.success(t('groups:groupMembers.addMembersSuccess', { count: successCount }));
      }
      if (alreadyMemberCount > 0) {
        toast.info(t('groups:groupMembers.alreadyMembers', { count: alreadyMemberCount }));
      }
      if (errors.length > 0) {
        errors.forEach(err => toast.error(err));
      }

      // Reset form and reload members
      setShowAddMember(false);
      setSearchQuery('');
      setSelectedRole('Reporter');
      setSearchResults([]);
      setShowSearchDropdown(false);
      setSelectedUsers([]);
      loadMembers();
      onSuccess();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveMember = async (userId: number) => {
    if (!group) return;

    if (!confirm(t('groups:groupMembers.confirmRemove'))) {
      return;
    }

    try {
      await removeGroupMember(group.name, userId);
      toast.success(t('groups:groups.messages.memberRemoved'));
      loadMembers();
      onSuccess();
    } catch (error: unknown) {
      console.error('Failed to remove member:', error);
      const err = error as { message?: string };
      const errorMessage = err?.message || t('groups:groupMembers.removeMemberFailed');
      toast.error(errorMessage);
    }
  };

  const handleUpdateRole = async (userId: number, newRole: GroupRole) => {
    if (!group) return;

    try {
      await updateGroupMemberRole(group.name, userId, { role: newRole });
      toast.success(t('groups:groups.messages.roleUpdated'));
      loadMembers();
      onSuccess();
    } catch (error: unknown) {
      console.error('Failed to update role:', error);
      const err = error as { message?: string };
      const errorMessage = err?.message || t('groups:groupMembers.updateRoleFailed');
      toast.error(errorMessage);
    }
  };

  const handleInviteAll = async () => {
    if (!group) return;

    if (!confirm(t('groups:groupMembers.confirmInviteAll'))) {
      return;
    }

    setIsSubmitting(true);
    try {
      await inviteAllUsers(group.name);
      toast.success(t('groups:groupMembers.inviteAllSuccess'));
      loadMembers();
      onSuccess();
    } catch (error: unknown) {
      console.error('Failed to invite all users:', error);
      const err = error as { message?: string };
      const errorMessage = err?.message || t('groups:groupMembers.inviteAllFailed');
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeaveGroup = async () => {
    if (!group) return;

    if (!confirm(t('groups:groupMembers.confirmLeave'))) {
      return;
    }

    try {
      await leaveGroup(group.name);
      toast.success(t('groups:groupMembers.leaveSuccess'));
      onSuccess();
      onClose();
    } catch (error: unknown) {
      console.error('Failed to leave group:', error);
      const err = error as { message?: string };
      const errorMessage = err?.message || t('groups:groupMembers.leaveFailed');
      toast.error(errorMessage);
    }
  };

  const getRoleBadgeVariant = (
    role: GroupRole
  ): 'default' | 'secondary' | 'success' | 'error' | 'warning' | 'info' => {
    switch (role) {
      case 'Owner':
        return 'error';
      case 'Maintainer':
        return 'default';
      case 'Developer':
        return 'secondary';
      case 'Reporter':
        return 'info';
      default:
        return 'info';
    }
  };

  if (!group) {
    return null;
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('groups:groups.actions.manageMembers')}
      maxWidth="3xl"
    >
      <div className="space-y-4">
        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pb-4 border-b border-border">
          {canAddMember && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddMember(!showAddMember)}
              disabled={isSubmitting}
            >
              <UserPlusIcon className="w-4 h-4 mr-2" />
              {t('groups:groups.actions.addMember')}
            </Button>
          )}
          {/* Temporarily hidden: Invite All Users button */}
          {false && canInviteAll && (
            <Button variant="outline" size="sm" onClick={handleInviteAll} disabled={isSubmitting}>
              <UserPlusIcon className="w-4 h-4 mr-2" />
              {t('groups:groups.actions.inviteAll')}
            </Button>
          )}
          {canLeave && (
            <Button variant="outline" size="sm" onClick={handleLeaveGroup}>
              <LogOutIcon className="w-4 h-4 mr-2" />
              {t('groups:groups.actions.leave')}
            </Button>
          )}
        </div>

        {/* Add Member Form */}
        {showAddMember && canAddMember && (
          <div className="p-4 border border-border rounded-lg bg-surface space-y-3">
            <h3 className="text-sm font-medium">{t('groups:groups.actions.addMember')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 relative">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                  <Input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onFocus={() => {
                      if (searchResults.length > 0) {
                        setShowSearchDropdown(true);
                      }
                    }}
                    placeholder={t('groups:groupMembers.searchPlaceholder')}
                    disabled={isSubmitting}
                    className="pl-9"
                  />
                </div>
                {/* Search Results Dropdown */}
                {showSearchDropdown && (searchResults.length > 0 || isSearching) && (
                  <div
                    ref={dropdownRef}
                    className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
                  >
                    {isSearching ? (
                      <div className="p-3 text-sm text-text-muted text-center">
                        {t('common:actions.loading')}
                      </div>
                    ) : (
                      searchResults.map(user => {
                        const isSelected = selectedUsers.some(u => u.id === user.id);
                        return (
                          <button
                            key={user.id}
                            onClick={() => handleSelectUser(user)}
                            disabled={isSelected}
                            className="w-full flex items-center gap-3 p-3 hover:bg-surface cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <div className="flex-1">
                              <span className="font-medium text-sm text-text-primary">
                                {user.user_name}
                              </span>
                              {user.email && (
                                <div className="text-xs text-text-muted">{user.email}</div>
                              )}
                            </div>
                            {isSelected && <Check className="h-4 w-4 text-green-500" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <div>
                <Select
                  value={selectedRole}
                  onValueChange={(value: GroupRole) => setSelectedRole(value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Owner">{t('groups:groups.roles.Owner')}</SelectItem>
                    <SelectItem value="Maintainer">
                      {t('groups:groups.roles.Maintainer')}
                    </SelectItem>
                    <SelectItem value="Developer">{t('groups:groups.roles.Developer')}</SelectItem>
                    <SelectItem value="Reporter">{t('groups:groups.roles.Reporter')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Selected Users */}
            {selectedUsers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">
                  {t('groups:groupMembers.selectedUsers', { count: selectedUsers.length })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.map(user => (
                    <Badge key={user.id} variant="secondary" className="pr-1">
                      {user.user_name}
                      <button
                        onClick={() => handleRemoveSelectedUser(user.id)}
                        className="ml-1 hover:bg-accent rounded-full p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Role Permission Description */}
            <div className="p-3 bg-muted rounded-md">
              <h4 className="text-sm font-medium mb-2">
                {t('groups:groupMembers.rolePermissions')}
              </h4>
              <div className="space-y-2 text-xs text-text-muted">
                {selectedRole === 'Reporter' && (
                  <div>
                    <strong>Reporter：</strong>
                    {t('groups:groupMembers.roleDescriptions.Reporter')}
                  </div>
                )}
                {selectedRole === 'Developer' && (
                  <div>
                    <strong>Developer：</strong>
                    {t('groups:groupMembers.roleDescriptions.Developer')}
                  </div>
                )}
                {selectedRole === 'Maintainer' && (
                  <div>
                    <strong>Maintainer：</strong>
                    {t('groups:groupMembers.roleDescriptions.Maintainer')}
                    <ul className="list-disc list-inside ml-2 mt-1">
                      <li>
                        {t(
                          'groups:groupMembers.roleDescriptions.MaintainerDetails.manageResources'
                        )}
                      </li>
                      <li>
                        {t('groups:groupMembers.roleDescriptions.MaintainerDetails.manageMembers')}
                      </li>
                      <li>
                        {t('groups:groupMembers.roleDescriptions.MaintainerDetails.updateRoles')}
                      </li>
                      <li>
                        {t('groups:groupMembers.roleDescriptions.MaintainerDetails.canLeave')}
                      </li>
                    </ul>
                  </div>
                )}
                {selectedRole === 'Owner' && (
                  <div>
                    <strong>Owner：</strong>
                    {t('groups:groupMembers.roleDescriptions.Owner')}
                    <ul className="list-disc list-inside ml-2 mt-1">
                      <li>{t('groups:groupMembers.roleDescriptions.OwnerDetails.fullControl')}</li>
                      <li>{t('groups:groupMembers.roleDescriptions.OwnerDetails.deleteGroup')}</li>
                      <li>
                        {t('groups:groupMembers.roleDescriptions.OwnerDetails.transferOwnership')}
                      </li>
                      <li>{t('groups:groupMembers.roleDescriptions.OwnerDetails.cannotLeave')}</li>
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowAddMember(false);
                  setSearchQuery('');
                  setSearchResults([]);
                  setShowSearchDropdown(false);
                  setSelectedUsers([]);
                }}
              >
                {t('common:actions.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleAddMembers}
                disabled={selectedUsers.length === 0 || isSubmitting}
              >
                <UserPlusIcon className="w-4 h-4 mr-2" />
                {isSubmitting
                  ? t('groups:groupMembers.adding')
                  : t('groups:groupMembers.addCount', { count: selectedUsers.length })}
              </Button>
            </div>
          </div>
        )}

        {/* Members Table */}
        {loading ? (
          <div className="text-center py-8 text-text-secondary">{t('common:actions.loading')}</div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[400px]">
              <table className="w-full">
                <thead className="bg-muted border-b border-border sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groups:groupMembers.username')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groups:groups.role')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groups:groupMembers.invitedBy')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groups:groupMembers.joinDate')}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-text-primary">
                      {t('groups:groupMembers.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {members.map(member => {
                    const isMe = member.user_id === currentUserId;
                    const isOwner = member.role === 'Owner';

                    return (
                      <tr key={member.id} className="hover:bg-surface">
                        <td className="px-4 py-3 text-sm font-medium text-text-primary">
                          {member.user_name || `User ${member.user_id}`}
                          {isMe && (
                            <Badge variant="info" className="ml-2">
                              {t('groups:groupMembers.you')}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {canUpdateRole && !isMe && !(myRole === 'Maintainer' && isOwner) ? (
                            <Select
                              value={member.role}
                              onValueChange={(value: GroupRole) =>
                                handleUpdateRole(member.user_id, value)
                              }
                            >
                              <SelectTrigger className="w-[140px]">
                                <Badge variant={getRoleBadgeVariant(member.role)}>
                                  {t(`groups:groups.roles.${member.role}`)}
                                </Badge>
                              </SelectTrigger>
                              <SelectContent>
                                {myRole === 'Owner' && (
                                  <SelectItem value="Owner">
                                    {t('groups:groups.roles.Owner')}
                                  </SelectItem>
                                )}
                                <SelectItem value="Maintainer">
                                  {t('groups:groups.roles.Maintainer')}
                                </SelectItem>
                                <SelectItem value="Developer">
                                  {t('groups:groups.roles.Developer')}
                                </SelectItem>
                                <SelectItem value="Reporter">
                                  {t('groups:groups.roles.Reporter')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant={getRoleBadgeVariant(member.role)}>
                              {t(`groups:groups.roles.${member.role}`)}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary">
                          {member.invited_by_user_name || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-text-secondary">
                          {new Date(member.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-sm text-right">
                          {canRemoveMember && !isOwner && !isMe && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveMember(member.user_id)}
                              className="text-error hover:text-error"
                            >
                              {t('groups:groupMembers.remove')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
