// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { ChevronDownIcon, UserGroupIcon, LinkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { cn } from '@/lib/utils';
import { TaskDetail } from '@/types/api';
import { TaskMembersPanel, InviteLinkDialog } from '@/features/tasks/components/group-chat';
import { taskApis } from '@/apis/tasks';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/hooks/useTranslation';
import { useUser } from '@/features/common/UserContext';

type TaskTitleDropdownProps = {
  title?: string;
  taskDetail?: TaskDetail | null;
  className?: string;
  onTaskDeleted?: () => void;
};

export default function TaskTitleDropdown({
  title,
  taskDetail,
  className,
  onTaskDeleted,
}: TaskTitleDropdownProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useUser();
  const displayTitle = title;
  const isGroupChat = taskDetail?.is_group_chat || false;

  const [showMembersDialog, setShowMembersDialog] = useState(false);
  const [showInviteLinkDialog, setShowInviteLinkDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleViewMembers = () => {
    setShowMembersDialog(true);
  };

  const handleManageInviteLink = () => {
    setShowInviteLinkDialog(true);
  };

  const handleDeleteGroup = async () => {
    if (!taskDetail?.id) return;

    const confirmed = confirm(
      isGroupChat
        ? t('groupChat.delete.confirmMessage', '确定要删除这个群聊吗？此操作无法撤销。')
        : t('task.delete.confirmMessage', '确定要删除这个任务吗？此操作无法撤销。')
    );

    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await taskApis.deleteTask(taskDetail.id);
      // Notify parent component
      if (onTaskDeleted) {
        onTaskDeleted();
      }
      // Clear URL parameters and refresh
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.delete('taskId');
        url.searchParams.delete('task_id');
        router.replace(url.pathname);
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
      alert(t('task.delete.error', '删除失败，请重试'));
    } finally {
      setIsDeleting(false);
    }
  };

  // Only show group chat options if it's a true group chat
  const showGroupChatOptions = isGroupChat;

  // If no title, don't render anything
  if (!displayTitle) {
    return null;
  }

  // If not a group chat, show simple dropdown
  if (!showGroupChatOptions) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-2 h-9 px-3 rounded-md',
              'text-text-primary font-medium text-base',
              'hover:bg-muted transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              'max-w-[300px]',
              className
            )}
          >
            <span className="truncate">{displayTitle}</span>
            <ChevronDownIcon className="h-4 w-4 flex-shrink-0 text-text-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem disabled className="text-text-muted text-xs">
            {displayTitle}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Group chat dropdown with additional options
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-2 h-9 px-3 rounded-md',
              'text-text-primary font-medium text-base',
              'hover:bg-muted transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              'max-w-[300px]',
              className
            )}
          >
            <Users className="h-4 w-4 flex-shrink-0 text-text-muted" />
            <span className="truncate">{displayTitle}</span>
            <ChevronDownIcon className="h-4 w-4 flex-shrink-0 text-text-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {/* Members option */}
          <DropdownMenuItem onClick={handleViewMembers} className="gap-2">
            <UserGroupIcon className="h-4 w-4" />
            <span>{t('groupChat.members.title', '人员')}</span>
          </DropdownMenuItem>

          {/* Invite link option */}
          <DropdownMenuItem onClick={handleManageInviteLink} className="gap-2">
            <LinkIcon className="h-4 w-4" />
            <span>{t('groupChat.inviteLink.manage', '管理群组链接')}</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Delete group option */}
          <DropdownMenuItem
            onClick={handleDeleteGroup}
            disabled={isDeleting}
            danger
            className="gap-2"
          >
            <TrashIcon className="h-4 w-4" />
            <span>
              {isDeleting
                ? t('common.deleting', '删除中...')
                : t('groupChat.delete.button', '删除群组')}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs */}
      {taskDetail && user && (
        <>
          <TaskMembersPanel
            open={showMembersDialog}
            onClose={() => setShowMembersDialog(false)}
            taskId={taskDetail.id}
            taskTitle={taskDetail.title}
            currentUserId={user.id}
            onLeave={() => {
              // Handle leave group chat
              if (onTaskDeleted) {
                onTaskDeleted();
              }
            }}
          />
          <InviteLinkDialog
            open={showInviteLinkDialog}
            onClose={() => setShowInviteLinkDialog(false)}
            taskId={taskDetail.id}
            taskTitle={taskDetail.title}
          />
        </>
      )}
    </>
  );
}
