// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Radio, Transfer, Select, Button } from 'antd'
import type { TransferDirection } from 'antd/es/transfer'
import type { MessageInstance } from 'antd/es/message/interface'
import Image from 'next/image'
import { RiRobot2Line } from 'react-icons/ri'
import { EditOutlined, DownOutlined, PlusOutlined } from '@ant-design/icons'

import { Bot, Team } from '@/types/api'
import { createTeam, updateTeam } from '../services/teams'
import TeamEditDrawer from './TeamEditDrawer'
import { useTranslation } from '@/hooks/useTranslation'

interface TeamEditProps {
  teams: Team[]
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>
  editingTeamId: number
  setEditingTeamId: React.Dispatch<React.SetStateAction<number | null>>
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>> // 添加 setBots 属性
  message: MessageInstance
}

export default function TeamEdit(props: TeamEditProps) {
  const {
    teams,
    setTeams,
    editingTeamId,
    setEditingTeamId,
    bots,
    setBots,
    message,
  } = props

  const { t } = useTranslation('common')
  // 当前编辑对象（0 表示新建）
  const editingTeam: Team | null = editingTeamId === 0
    ? null
    : (teams.find(t => t.id === editingTeamId) || null)

  // 左列：Team Name, Mode, 说明
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'pipeline' | 'route' | 'coordinate' | 'collaborate'>('pipeline')

  // 右列：LeaderBot（单选），Bots 穿梭框（多选）
  // antd Transfer 使用 string key，这里用字符串化的 bot.id
  const [selectedBotKeys, setSelectedBotKeys] = useState<React.Key[]>([])
  const [leaderBotId, setLeaderBotId] = useState<number | null>(null)

  const [saving, setSaving] = useState(false)

  // Bot编辑相关状态
  const [editingBotDrawerVisible, setEditingBotDrawerVisible] = useState(false)
  const [editingBotId, setEditingBotId] = useState<number | null>(null)
  const [drawerMode, setDrawerMode] = useState<'edit' | 'prompt'>('edit')

  // 不同 Mode 的“说明”和“边界”，均包含文字与图片（国际化）
  const MODE_INFO = useMemo(() => {
    // i18n keys
    const titleKey = `team_model.${mode}`;
    const descKey = `team_model_desc.${mode}`;

    // 图片按模式固定映射
    const imageMap: Record<typeof mode, string> = {
      pipeline: '/settings/sequential.png',
      route: '/settings/router.png',
      coordinate: '/settings/network.png',
      collaborate: '/settings/parallel.png',
    };

    return {
      info: {
        title: t(titleKey),
        desc: t(descKey),
        bullets: [],
        image: imageMap[mode],
      },
    };
  }, [mode, t]);

  // 初始化/切换编辑对象时重置表单
  useEffect(() => {
    if (editingTeam) {
      setName(editingTeam.name)
      const m = (editingTeam.workflow?.mode as any) || 'pipeline'
      setMode(m)
      const ids = editingTeam.bots
        .filter(b => bots.some(bot => bot.id === b.bot_id))
        .map(b => String(b.bot_id))
      setSelectedBotKeys(ids)
      // 查找role="leader"的bot作为leader，如果没有则默认使用第一个
      const leaderBot = editingTeam.bots.find(b => b.role === 'leader' && bots.some(bot => bot.id === b.bot_id))
      setLeaderBotId(leaderBot?.bot_id ?? null)
    } else {
      setName('')
      setMode('pipeline')
      setSelectedBotKeys([])
      setLeaderBotId(null)
    }
  }, [editingTeamId, bots])

  // 变更 Mode
  const handleModeChange = (newMode: 'pipeline' | 'route' | 'coordinate' | 'collaborate') => {
    setMode(newMode)
    setSelectedBotKeys([])
  }
  // 获取当前选中的 agent_name（从 leader 或已选的 bot 中）
  const selectedAgentName = useMemo(() => {
    // 如果是 pipeline 模式，不需要限制 agent_name
    if (mode === 'pipeline') return null;

    // 如果有 leader，优先使用 leader 的 agent_name
    if (leaderBotId !== null) {
      const leaderBot = bots.find(b => b.id === leaderBotId);
      if (leaderBot) return leaderBot.agent_name;
    }

    // 如果没有 leader 但有选中的 bot，使用第一个选中 bot 的 agent_name
    if (selectedBotKeys.length > 0) {
      const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
      if (firstSelectedBot) return firstSelectedBot.agent_name;
    }

    // 没有任何选择，返回 null
    return null;
  }, [mode, leaderBotId, selectedBotKeys, bots]);

  // 供 Transfer 使用的数据源
  const transferData = useMemo(
    () => {
      return bots.map(b => ({
        key: String(b.id),
        title: b.name,
        description: b.agent_name,
        disabled:
          // 在非 pipeline 模式下，如果已经选择了 agent_name，则禁用不匹配的选项
          mode !== 'pipeline' &&
          selectedAgentName !== null &&
          b.agent_name !== selectedAgentName
      }))
    },
    [bots, mode, selectedAgentName]
  )

  // 穿梭框变更
  const onTransferChange = (targetKeys: React.Key[], direction: TransferDirection, moveKeys: React.Key[]) => {
    if (direction === 'right') {
      setSelectedBotKeys([...new Set(selectedBotKeys.concat(moveKeys))]);
      return;
    }
    setSelectedBotKeys(targetKeys);
  }
  // Leader 切换
  const onLeaderChange = (botId: number) => {
    // 如果新的leader在已选bot中，需要将其从已选bot中移除
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId))
    }

    setLeaderBotId(botId)

    // 如果是非 pipeline 模式，根据新选择的 leader 的 agent_name 过滤已选的 bots
    if (mode !== 'pipeline') {
      const leaderBot = bots.find(b => b.id === botId);
      if (leaderBot) {
        // 过滤掉不匹配 agent_name 的已选 bots
        setSelectedBotKeys(prev =>
          prev.filter(key => {
            const bot = bots.find(b => String(b.id) === key);
            return bot && bot.agent_name === leaderBot.agent_name;
          })
        );
      }
    }
  }
  // 校验 agent_name 一致（非 pipeline 模式要求一致）
  const validateAgentNameConsistency = (ids: number[]) => {
    const selected = bots.filter(b => ids.includes(b.id))
    const agentNames = Array.from(new Set(selected.map(b => b.agent_name)))
    return agentNames.length <= 1
  }

  // 保存
  const handleSave = async () => {
    if (!name.trim()) {
      message.error('Team name is required')
      return
    }
    if (selectedBotKeys.length === 0) {
      message.error('At least one bot must be selected')
      return
    }
    if (leaderBotId == null) {
      message.error('Leader bot is required')
      return
    }
    const selectedIds = selectedBotKeys.map(k => Number(k))

    // 非 pipeline 模式要求 agent_name 一致
    if (mode !== 'pipeline') {
      if (!validateAgentNameConsistency(selectedIds)) {
        message.error('非 Pipeline 模式仅支持选择 agent_name 相同的 Bot')
        return
      }
    }

    // 组装 bots 数据（目前暂不支持 per-step prompt，自然全部 prompt 为空）
    // 确保 leader bot 是第一位，其他bot按照穿梭框的顺序排列
    let allBotIds: number[] = [];

    // 首先添加 leader bot（如果有）
    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId);
    }

    // 然后添加其他 bot，确保不重复添加 leader bot
    selectedIds.forEach(id => {
      if (id !== leaderBotId) {
        allBotIds.push(id);
      }
    });

    // 创建 botsData，保持 allBotIds 的顺序
    const botsData = allBotIds.map(id => ({
      bot_id: id,
      bot_prompt: '',
      role: id === leaderBotId ? 'leader' : undefined,
    }))

    const workflow = { mode, leader_bot_id: leaderBotId }

    setSaving(true)
    try {
      if (editingTeam && editingTeamId && editingTeamId > 0) {
        const updated = await updateTeam(editingTeamId, {
          name: name.trim(),
          workflow,
          bots: botsData
        })
        setTeams(prev => prev.map(team => team.id === updated.id ? updated : team))
      } else {
        const created = await createTeam({
          name: name.trim(),
          workflow,
          bots: botsData
        })
        setTeams(prev => [created, ...prev])
      }
      setEditingTeamId(null)
    } catch (e: any) {
      message.error(e?.message || (editingTeam ? 'Failed to edit team' : 'Failed to create team'))
    } finally {
      setSaving(false)
    }
  }

  // Leader 下拉可选项，在非 pipeline 模式下根据已选 bot 的 agent_name 过滤
  const leaderOptions = useMemo(
    () => {
      // 如果是 pipeline 模式，显示所有 bots
      if (mode === 'pipeline') return bots;

      // 如果非 pipeline 模式且已有选中的 bot
      if (selectedBotKeys.length > 0) {
        // 找到第一个选中的 bot
        const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
        if (firstSelectedBot) {
          // 只显示相同 agent_name 的 bots
          return bots.filter(b => b.agent_name === firstSelectedBot.agent_name);
        }
      }

      // 没有选中的 bot，显示所有 bots
      return bots;
    },
    [bots, mode, selectedBotKeys]
  )

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => t.id === updatedTeam.id ? updatedTeam : t))
  }


  return (
    <div className="flex flex-col flex-1 items-stretch max-w-4xl mx-auto bg-surface rounded-lg pt-0 pr-4 pb-4 pl-4 relative w-full h-full min-h-[500px] md:min-h-[65vh]">
      {/* 顶部工具条：Back + Save */}
      <div className="w-full flex items-center justify-between mb-4 mt-4">
        <button
          onClick={() => setEditingTeamId(null)}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>
        <Button
          type="primary"
          onClick={handleSave}
          disabled={saving}
          loading={saving}
        >
          {saving ? (editingTeam ? t('actions.saving') : t('actions.creating')) : t('actions.save')}
        </Button>
      </div>

      {/* 双栏布局：左（名称、模式、说明图片）、右（LeaderBot、Bots 穿梭框） */}
      <div className="w-full flex flex-col md:flex-row gap-4 items-stretch flex-1 h-full py-0">
        {/* 左列 */}
        <div className="w-full md:w-2/5 min-w-0 flex flex-col space-y-4 h-full">
          {/* Team Name */}
          <div className="flex flex-col">
            <label className="block text-lg font-semibold text-text-primary mb-1">
              {t('team.name')} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('team.name_placeholder')}
              className="w-full px-4 py-1 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base"
            />
          </div>

          {/* Mode 组件 */}
          <div className='min-h-[400px] flex flex-col'>
            <label className="block text-lg font-semibold text-text-primary mb-1">
              {t('team.model')} <span className="text-red-400">*</span>
            </label>

            {/* 整合 Mode 选择和说明到一个统一容器 */}
            <div className="rounded-md border min-h-[400px] border-border bg-base p-3 h-full flex flex-col">
              {/* Mode 选择 - 保留 Radio.Group */}
              <div className="mb-3">
                <Radio.Group
                  value={mode}
                  onChange={(e) => handleModeChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={['pipeline', 'route', 'coordinate', 'collaborate'].map(opt => ({
                    label: t(`team_model.${opt}`),
                    value: opt as any,
                    style: { minWidth: 20, padding: '0 12px', textAlign: 'center' }
                  }))}
                  className="w-full"
                />
              </div>

              {/* 分隔线 */}
              <div className="border-t border-border my-2"></div>

              {/* Mode 说明 */}
              <div className="flex-1 flex flex-col">
                <p className="text-sm text-text-secondary">{MODE_INFO.info.desc}</p>

                {MODE_INFO.info.bullets.length > 0 && (
                  <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-text-secondary">
                    {MODE_INFO.info.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}

                <div className="mt-auto pt-3 rounded-md overflow-hidden flex items-center justify-center">
                  <Image src={MODE_INFO.info.image} alt={MODE_INFO.info.title} width={640} height={360} className="object-contain" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右列 */}
        <div className="w-full md:w-3/5 min-w-0 flex flex-col space-y-4 h-full">
          {/* LeaderBot 单选 */}
          <div className="flex flex-col">
            <label className="block text-lg font-semibold text-text-primary mb-1">
              {t('team.leader')} <span className="text-red-400">*</span>
            </label>
            <Select
              value={leaderBotId ?? undefined}
              onChange={onLeaderChange}
              placeholder={t('team.select_leader')}
              suffixIcon={<DownOutlined className="text-text-secondary" />}
              notFoundContent={<div className="text-sm text-text-muted">Select Bots</div>}
              className="w-full"
              options={leaderOptions.map((b: Bot) => ({
                value: b.id,
                label: (
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center space-x-2">
                      <RiRobot2Line className="w-4 h-4 text-text-muted" />
                      <span className="block truncate">
                        {b.name} <span className="text-text-muted text-xs">({b.agent_name})</span>
                      </span>
                    </div>
                    <EditOutlined
                      className="ml-8 text-text-secondary hover:text-text-primary cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发选择
                        setDrawerMode('edit')
                        setEditingBotId(b.id);
                        setEditingBotDrawerVisible(true);
                      }}
                    />
                  </div>
                )
              }))}
              optionFilterProp="children"
              popupMatchSelectWidth={true}
              listHeight={250}
              menuItemSelectedIcon={null}
              dropdownStyle={{ minWidth: '200px' }}
            />
          </div>

          {/* Bots 穿梭框 */}
          <div className="flex flex-col flex-1 min-h-[280px]">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.bots')}
              </label>
              <Button
                type="link"
                size="small"
                className="!text-text-muted hover:!text-text-primary"
                onClick={() => {
                  if (!editingTeam) {
                    message.info('Please save the team before editing prompts.')
                    return
                  }
                  setDrawerMode('prompt');
                  setEditingBotDrawerVisible(true);
                }}
              >
                Edit Team Prompts
              </Button>
            </div>
            <div className="relative flex-1 min-h-[260px] bg-transparent">
              <Transfer
                oneWay
                dataSource={transferData.filter(item => Number(item.key) !== leaderBotId)}
                targetKeys={selectedBotKeys}
                onChange={onTransferChange}
                render={item => (
                  <div className="flex items-center justify-between w-full">
                    <span className="truncate">
                      {item.title}
                      <span className="text-xs text-text-muted">({item.description})</span>
                    </span>

                    <div className="flex items-center">

                      <EditOutlined
                        className="ml-2 text-text-secondary hover:text-text-primary cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation(); // 阻止事件冒泡，避免触发选择
                          setDrawerMode('edit')
                          setEditingBotId(Number(item.key));
                          setEditingBotDrawerVisible(true);
                        }}
                      />
                    </div>
                  </div>
                )}
                titles={[t("team.candidates"), t("team.in_team")]}
                style={{}}
                listStyle={{
                  minHeight: 400,
                  width: '50%',
                  backgroundColor: 'rgb(var(--color-bg-base))',
                  borderColor: 'rgb(var(--color-border))',
                }}
                locale={{
                  itemUnit: 'item',
                  itemsUnit: 'items',
                  notFoundContent: t("team.no_data"),
                }}
                footer={(_, info) => {
                  if (info?.direction === 'left') {
                    return (
                      <div className="p-2 text-center">
                        <Button
                          type="primary"
                          size="small"
                          ghost
                          className="w-70"
                          icon={<PlusOutlined />}
                          onClick={() => {
                            setDrawerMode('edit');
                            setEditingBotId(0);
                            setEditingBotDrawerVisible(true);
                          }}
                        >
                          New Bot
                        </Button>
                      </div>
                    );
                  }
                  return null;
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bot编辑抽屉 */}
      <TeamEditDrawer
        bots={bots}
        setBots={setBots}
        editingBotId={editingBotId}
        setEditingBotId={setEditingBotId}
        visible={editingBotDrawerVisible}
        setVisible={setEditingBotDrawerVisible}
        message={message}
        mode={drawerMode}
        editingTeam={editingTeam}
        onTeamUpdate={handleTeamUpdate}
      />
    </div>
  )
}
