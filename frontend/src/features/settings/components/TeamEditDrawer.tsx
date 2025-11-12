// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Drawer, Form, Input, Button, Alert, Tooltip } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import { teamApis } from '@/apis/team';
import { useTranslation } from 'react-i18next';

import { Bot, Team, TeamBot } from '@/types/api';
import BotEdit from './BotEdit';

interface TeamEditDrawerProps {
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  editingBotId: number | null;
  setEditingBotId: React.Dispatch<React.SetStateAction<number | null>>;
  visible: boolean;
  setVisible: React.Dispatch<React.SetStateAction<boolean>>;
  message: MessageInstance;
  mode: 'edit' | 'prompt';
  editingTeam: Team | null;
  onTeamUpdate: (updatedTeam: Team) => void;
  cloningBot: Bot | null;
  setCloningBot: React.Dispatch<React.SetStateAction<Bot | null>>;
  // Added property to handle new team cases
  selectedBotKeys?: React.Key[];
  leaderBotId?: number | null;
  unsavedPrompts?: Record<string, string>;
  setUnsavedPrompts?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

function PromptEdit({
  team,
  allBots,
  onClose,
  message,
  onTeamUpdate,
  isNewTeam = false,
  selectedBotKeys = [],
  leaderBotId = null,
  unsavedPrompts = {},
  setUnsavedPrompts,
}: {
  team?: Team;
  allBots: Bot[];
  onClose: () => void;
  message: MessageInstance;
  onTeamUpdate: (updatedTeam: Team) => void;
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  isNewTeam?: boolean;
  selectedBotKeys?: React.Key[];
  leaderBotId?: number | null;
  unsavedPrompts?: Record<string, string>;
  setUnsavedPrompts?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const { t } = useTranslation('common');
  const [form] = Form.useForm();
  const [loading, setLoading] = React.useState(false);
  const drawerTitle = React.useMemo(() => {
    if (isNewTeam) return t('team.prompts_drawer_title_new');
    if (team) return t('team.prompts_drawer_title_existing', { name: team.name });
    return t('team.prompts_drawer_title_generic');
  }, [isNewTeam, team, t]);

  const handleBack = React.useCallback(() => {
    onClose();
  }, [onClose]);

  const teamBotsWithDetails = React.useMemo(() => {
    if (isNewTeam) {
      // Handle new team case
      const allBotIds = [...(selectedBotKeys || [])];
      if (leaderBotId !== null && !allBotIds.includes(String(leaderBotId))) {
        allBotIds.unshift(String(leaderBotId));
      }

      return allBotIds.map(botId => {
        const botDetails = allBots.find(b => String(b.id) === String(botId));
        const numericBotId = Number(botId);
        return {
          bot_id: numericBotId,
          bot_prompt: unsavedPrompts[`prompt-${numericBotId}`] || '',
          name: botDetails?.name || `Bot ID: ${botId}`,
          isLeader: numericBotId === leaderBotId,
          basePrompt: botDetails?.system_prompt || '',
        };
      });
    } else if (!team) {
      return [];
    } else {
      // Handle existing team case, including unsaved new Bot
      const selectedIds = Array.isArray(selectedBotKeys)
        ? (selectedBotKeys as React.Key[]).map(key => Number(key)).filter(id => !Number.isNaN(id))
        : [];

      const orderedIds: number[] = [];
      if (leaderBotId !== null) {
        orderedIds.push(leaderBotId);
      }
      selectedIds.forEach(id => {
        if (!orderedIds.includes(id)) {
          orderedIds.push(id);
        }
      });
      team.bots.forEach(teamBot => {
        if (!orderedIds.includes(teamBot.bot_id)) {
          orderedIds.push(teamBot.bot_id);
        }
      });

      return orderedIds.map(botId => {
        const teamBot = team.bots.find(b => b.bot_id === botId);
        const botDetails = allBots.find(b => b.id === botId);
        const promptKey = `prompt-${botId}`;
        const promptValue = unsavedPrompts?.[promptKey] ?? teamBot?.bot_prompt ?? '';

        return {
          bot_id: botId,
          bot_prompt: promptValue,
          name: botDetails?.name || (teamBot ? `Bot ID: ${teamBot.bot_id}` : `Bot ID: ${botId}`),
          isLeader: teamBot?.role === 'leader' || botId === leaderBotId,
          basePrompt: botDetails?.system_prompt || '',
          role: teamBot?.role,
        };
      });
    }
  }, [team, allBots, isNewTeam, selectedBotKeys, leaderBotId, unsavedPrompts]);

  React.useEffect(() => {
    const initialValues: Record<string, string> = {};
    if (teamBotsWithDetails) {
      teamBotsWithDetails.forEach(bot => {
        initialValues[`prompt-${bot.bot_id}`] = bot.bot_prompt;
      });
      form.setFieldsValue(initialValues);
    }
  }, [teamBotsWithDetails, form]);

  React.useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;

      const activeElement = document.activeElement as HTMLElement | null;
      if (
        activeElement &&
        (activeElement.getAttribute('role') === 'combobox' ||
          activeElement.closest('.ant-select-dropdown'))
      ) {
        return;
      }

      handleBack();
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleBack]);

  const handleSave = async () => {
    try {
      setLoading(true);
      const values = await form.validateFields();
      const existingBotIds = team ? team.bots.map(bot => bot.bot_id) : [];
      const currentBotIds = teamBotsWithDetails.map(bot => bot.bot_id);
      const structureChanged =
        currentBotIds.length !== existingBotIds.length ||
        currentBotIds.some(id => !existingBotIds.includes(id)) ||
        existingBotIds.some(id => !currentBotIds.includes(id));
      const existingLeaderId = team?.bots.find(b => b.role === 'leader')?.bot_id ?? null;
      const leaderChanged = (leaderBotId ?? null) !== (existingLeaderId ?? null);
      const shouldPersistLocally = isNewTeam || structureChanged || leaderChanged;

      const collectPrompts = () => {
        const newPrompts: Record<string, string> = {};
        teamBotsWithDetails.forEach(bot => {
          const key = `prompt-${bot.bot_id}`;
          const value = (values[key] ?? '').trim();
          newPrompts[key] = value;
        });
        return newPrompts;
      };

      if (shouldPersistLocally) {
        if (setUnsavedPrompts) {
          setUnsavedPrompts(collectPrompts());
        }
        message.success(t('team.prompts_save_success'));
        onClose();
        return;
      }

      if (team) {
        // Handle existing team case
        const updatedBots: TeamBot[] = team.bots.map(teamBot => ({
          ...teamBot,
          bot_prompt: values[`prompt-${teamBot.bot_id}`] || '',
        }));

        await teamApis.updateTeam(team.id, {
          name: team.name,
          workflow: team.workflow,
          bots: updatedBots,
        });

        // Update team state
        onTeamUpdate({ ...team, bots: updatedBots });

        // Update global bots state
        // Note: No need to update global bots here, as bot_prompt is team-specific
        // If other bot properties need to be synced in the future, add here

        message.success(t('team.prompts_update_success'));
        onClose();
      }
    } catch {
      message.error(t('team.prompts_update_error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mr-1"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>
        <Button type="primary" onClick={handleSave} loading={loading}>
          {t('actions.save')}
        </Button>
      </div>

      <h2 className="text-lg font-semibold mb-3">{drawerTitle}</h2>
      <Alert
        type="info"
        showIcon
        message={t('team.prompts_scope_hint')}
        description={t('team.prompts_scope_sub')}
        className="mb-4"
      />
      <Form
        form={form}
        layout="vertical"
        className="flex-grow overflow-y-auto custom-scrollbar pr-4"
      >
        {teamBotsWithDetails.map(bot => (
          <Form.Item
            key={bot.bot_id}
            label={
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  {bot.name}
                  {bot.isLeader && (
                    <span className="text-gray-400 ml-2 font-semibold">(Leader)</span>
                  )}
                </span>
                {bot.basePrompt && (
                  <Tooltip
                    title={
                      <div className="max-w-xs whitespace-pre-wrap text-xs leading-5">
                        {bot.basePrompt}
                      </div>
                    }
                    overlayStyle={{ maxWidth: 360 }}
                  >
                    <Button type="link" size="small" className="!px-0">
                      {t('team.prompts_base_button')}
                    </Button>
                  </Tooltip>
                )}
              </div>
            }
            name={`prompt-${bot.bot_id}`}
          >
            <Input.TextArea rows={4} placeholder={t('team.prompts_placeholder')} />
          </Form.Item>
        ))}
      </Form>
    </div>
  );
}

export default function TeamEditDrawer(props: TeamEditDrawerProps) {
  const {
    bots,
    setBots,
    editingBotId,
    setEditingBotId,
    visible,
    setVisible,
    message,
    mode,
    editingTeam,
    onTeamUpdate,
    cloningBot,
    setCloningBot,
  } = props;

  const handleClose = () => {
    setVisible(false);
    setEditingBotId(null);
    setCloningBot(null);
  };

  return (
    <Drawer
      placement="right"
      width={860}
      onClose={handleClose}
      open={visible}
      destroyOnClose={true}
      styles={{
        header: {
          display: 'none',
        },
        body: { backgroundColor: 'rgb(var(--color-bg-base))', padding: 0 },
      }}
    >
      <div style={{ height: '100%', overflowY: 'auto' }}>
        {mode === 'edit' && editingBotId !== null && (
          <BotEdit
            bots={bots}
            setBots={setBots}
            editingBotId={editingBotId}
            cloningBot={cloningBot}
            onClose={() => {
              setEditingBotId(null);
              setCloningBot(null);
              setVisible(false);
            }}
            message={message}
          />
        )}
        {mode === 'prompt' && (
          <PromptEdit
            team={editingTeam || undefined}
            allBots={bots}
            onClose={handleClose}
            message={message}
            onTeamUpdate={onTeamUpdate}
            setBots={setBots}
            isNewTeam={!editingTeam}
            selectedBotKeys={props.selectedBotKeys}
            leaderBotId={props.leaderBotId}
            unsavedPrompts={props.unsavedPrompts}
            setUnsavedPrompts={props.setUnsavedPrompts}
          />
        )}
      </div>
    </Drawer>
  );
}
