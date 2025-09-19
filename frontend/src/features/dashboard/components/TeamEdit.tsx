// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Radio, Transfer, Drawer } from 'antd'
import type { TransferDirection } from 'antd/es/transfer'
import type { MessageInstance } from 'antd/es/message/interface'
import Image from 'next/image'
import { Listbox } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { RiRobot2Line } from 'react-icons/ri'
import { EditOutlined } from '@ant-design/icons'

import { Bot, Team } from '@/types/api'
import { createTeam, updateTeam } from '../services/teams'
import BotEdit from './BotEdit'

interface TeamEditProps {
  teams: Team[]
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>
  editingTeamId: number
  setEditingTeamId: React.Dispatch<React.SetStateAction<number | null>>
  bots: Bot[]
  message: MessageInstance
}

export default function TeamEdit(props: TeamEditProps) {
  const {
    teams,
    setTeams,
    editingTeamId,
    setEditingTeamId,
    bots,
    message,
  } = props

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

  // 不同 Mode 的“说明”和“边界”，均包含文字与图片
  const MODE_INFO = useMemo(() => {
    switch (mode) {
      case 'pipeline':
        return {
          info: {
            title: 'Pipeline',
            desc: 'Agents are chained one after another, where each agent refines or transforms the result in turn.',
            bullets: [],
            image: '/dashboard/sequential.png',
          },
        }
      case 'route':
        return {
          info: {
            title: 'Route',
            desc: 'A central agent acts as a message router, directing communication between agents without them talking directiy.',
            bullets: [],
            image: '/dashboard/router.png',
          }
        }
      case 'coordinate':
        return {
          info: {
            title: 'Coordinate',
            desc: 'A network pattern is the structure that defines how agents connect, exchange information, and coordinate with each other.',
            bullets: [],
            image: '/dashboard/network.png',
          }
        }
      case 'collaborate':
        return {
          info: {
            title: 'Collaborate',
            desc: 'Multiple agents work simultaneously on tasks, often sharing results to speed up processing.',
            bullets: [],
            image: '/dashboard/parallel.png',
          }
        }
      default:
        return {
          info: {
            title: '未知模式',
            desc: '请在上方选择有效的 Mode。',
            bullets: [],
            image: '/1.png',
          }
        }
    }
  }, [mode])

  // 初始化/切换编辑对象时重置表单
  useEffect(() => {
    if (editingTeam) {
      setName(editingTeam.name)
      const m = (editingTeam.workflow?.mode as any) || 'pipeline'
      setMode(m)
      const ids = editingTeam.bots.map(b => String(b.bot_id))
      setSelectedBotKeys(ids)
      // 查找role="leader"的bot作为leader，如果没有则默认使用第一个
      const leaderBot = editingTeam.bots.find(b => b.role === 'leader')
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
    // 交互层面只切换说明与校验策略；选中的 bots/leader 不重置，减少用户重复操作
  }
  // 供 Transfer 使用的数据源
  const transferData = useMemo(
    () =>
      bots.map(b => ({
        key: String(b.id),
        title: b.name,
        description: b.agent_name,
      })),
    [bots]
  )
  
  // 穿梭框变更
  const onTransferChange = (targetKeys: React.Key[], direction: TransferDirection, moveKeys: React.Key[]) => {
    // 如果移动的keys中包含当前的leaderBot，则不允许移动到右侧
    if (direction === 'right' && moveKeys.some(k => Number(k) === leaderBotId)) {
      message.warning('Leader bot 不能添加到团队成员列表中')
      // 从targetKeys中移除leaderBot
      const filteredKeys = targetKeys.filter(k => Number(k) !== leaderBotId)
      setSelectedBotKeys(filteredKeys)
      return
    }
    
    // 保持 targetKeys 顺序为 antd 默认行为（移动到右侧尾部）
    setSelectedBotKeys(targetKeys)
  }

  // Leader 切换
  const onLeaderChange = (botId: number) => {
    // 如果新的leader在已选bot中，需要将其从已选bot中移除
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId))
    }
    setLeaderBotId(botId)
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
    // 确保 leader bot 也被包含在最终的 team 中
    const allBotIds = [...selectedIds];
    
    // 如果 leader bot 不在 selectedIds 中，添加它
    if (leaderBotId !== null && !allBotIds.includes(leaderBotId)) {
      allBotIds.push(leaderBotId);
    }
    
    // 对于 pipeline，按穿梭框目标面板的顺序（antd 会保持加入顺序）
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

  // Leader 下拉可选项展示所有 bots
  const leaderOptions = useMemo(
    () => bots,
    [bots]
  )

  return (
    <div className="flex flex-col flex-1 items-stretch max-w-4xl mx-auto bg-[#161b22] rounded-lg pt-0 pr-4 pb-4 pl-4 relative w-full h-full min-h-[500px] md:min-h-[65vh]">
      {/* 顶部工具条：Back + Save */}
      <div className="w-full flex items-center justify-between mb-4 mt-4">
        <button
          onClick={() => setEditingTeamId(null)}
          className="flex items-center text-gray-400 hover:text-white text-base"
          title="Back"
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center space-x-1 px-4 py-1 text-sm font-medium text-gray-900 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: !saving ? 'rgb(112,167,215)' : '#6b7280' }}
        >
          {saving ? (editingTeam ? 'Saving...' : 'Creating...') : 'save'}
        </button>
      </div>

      {/* 双栏布局：左（名称、模式、说明图片）、右（LeaderBot、Bots 穿梭框） */}
      <div className="w-full flex flex-col md:flex-row gap-4 items-stretch flex-1 h-full py-0">
        {/* 左列 */}
        <div className="w-full md:w-2/5 min-w-0 flex flex-col space-y-4 h-full">
          {/* Team Name */}
          <div className="flex flex-col">
            <label className="block text-lg font-semibold text-white mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Team Name"
              className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent text-base"
            />
          </div>

          {/* Mode 组件 */}
          <div className='min-h-[400px] flex flex-col'>
            <label className="block text-lg font-semibold text-white mb-1">
              Model <span className="text-red-400">*</span>
            </label>

            {/* 整合 Mode 选择和说明到一个统一容器 */}
            <div className="rounded-md border min-h-[400px] border-[#30363d] bg-[#0d1117] p-3 h-full flex flex-col">
              {/* Mode 选择 - 保留 Radio.Group */}
              <div className="mb-3">
                <Radio.Group
                  value={mode}
                  onChange={(e) => handleModeChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={['pipeline', 'route', 'coordinate', 'collaborate'].map(opt => ({
                    label: opt.charAt(0).toUpperCase() + opt.slice(1),
                    value: opt,
                    style: { minWidth: 20, padding: '0 12px', textAlign: 'center' }
                  }))}
                  className="w-full"
                />
              </div>

              {/* 分隔线 */}
              <div className="border-t border-[#30363d] my-2"></div>

              {/* Mode 说明 */}
              <div className="flex-1 flex flex-col">
                <p className="text-sm text-gray-300">{MODE_INFO.info.desc}</p>

                {MODE_INFO.info.bullets.length > 0 && (
                  <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-gray-300">
                    {MODE_INFO.info.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}

                <div className="mt-auto pt-3 rounded-md overflow-hidden flex items-center justify-center">
                  <Image src={MODE_INFO.info.image} alt="mode info" width={640} height={360} className="object-contain" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右列 */}
        <div className="w-full md:w-3/5 min-w-0 flex flex-col space-y-4 h-full">
          {/* LeaderBot 单选 */}
          <div className="flex flex-col">
            <label className="block text-lg font-semibold text-white mb-1">
              Leader <span className="text-red-400">*</span>
            </label>
            <Listbox value={leaderBotId ?? undefined} onChange={onLeaderChange}>
              <div className="relative">
                <Listbox.Button className="w-full px-4 py-2 bg-[#0d1117] rounded-md text-left text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent text-base border border-[#30363d]">
                  <div className="flex items-center">
                    <RiRobot2Line className="w-4 h-4 mr-2 text-gray-400" />
                    <span className="truncate flex-1">
                      {leaderBotId != null
                        ? (bots.find(b => b.id === leaderBotId)?.name ?? 'Select leader')
                        : 'Select leader'}
                    </span>
                    <ChevronDownIcon className="w-5 h-5 ml-2 text-gray-300" />
                  </div>
                </Listbox.Button>
                <Listbox.Options className="absolute z-10 mt-1 w-full bg-[#161b22] rounded-md shadow-lg max-h-60 py-1 text-base ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm border border-[#30363d]">
                  {leaderOptions.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-400">请先在右侧选择 Bots</div>
                  ) : (
                    leaderOptions.map((b) => (
                      <Listbox.Option
                        key={b.id}
                        value={b.id}
                        className={({ active, selected }) =>
                          `select-none relative py-2 pl-3 pr-4 ${active ? 'bg-[#21262d] text-white cursor-pointer' : 'text-gray-300 cursor-pointer'
                          } ${selected ? 'font-semibold' : ''}`
                        }
                      >
                        {({ selected }) => (
                          <div className="flex items-center space-x-2">
                            <RiRobot2Line className="w-4 h-4 text-gray-400" />
                            <span className={`block truncate ${selected ? 'text-white' : ''}`}>
                              {b.name} <span className="text-gray-500 text-xs">({b.agent_name})</span>
                            </span>
                          </div>
                        )}
                      </Listbox.Option>
                    ))
                  )}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>

          {/* Bots 穿梭框 */}
          <div className="flex flex-col flex-1 min-h-[280px]">
            <label className="block text-lg font-semibold text-white mb-1">
              Bots
            </label>
            <div className="relative flex-1 min-h-[260px] bg-transparent">
              <Transfer
                dataSource={transferData.filter(item => Number(item.key) !== leaderBotId)}
                targetKeys={selectedBotKeys}
                onChange={onTransferChange}
                render={item => (
                  <div className="flex items-center justify-between w-full">
                    <span className="truncate">
                      {item.title}
                      <span className="text-xs text-gray-400">({item.description})</span>
                    </span>

                    <div className="flex items-center">

                      <EditOutlined
                        className="ml-2 text-gray-400 hover:text-white cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation(); // 阻止事件冒泡，避免触发选择
                          setEditingBotId(Number(item.key));
                          setEditingBotDrawerVisible(true);
                        }}
                      />
                    </div>
                  </div>
                )}
                titles={['candidates', 'in team']}
                style={{}}
                listStyle={{
                  minHeight: 400,
                  width: '50%',
                  backgroundColor: '#0d1117',
                  borderColor: '#30363d',
                }}
                locale={{
                  itemUnit: 'item',
                  itemsUnit: 'items',
                  notFoundContent: 'no data',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bot编辑抽屉 */}
      <Drawer
        title="编辑Bot"
        placement="right"
        width={800}
        onClose={() => {
          setEditingBotDrawerVisible(false);
          setEditingBotId(null);
        }}
        open={editingBotDrawerVisible}
        destroyOnClose={true}
        styles={{
          header: { display: "none", backgroundColor: '#161b22', color: 'white', borderBottom: '1px solid #30363d' },
          body: { backgroundColor: '#0d1117', padding: 0 },
        }}
      >
        {editingBotId !== null && (
          <BotEdit
            bots={bots}
            setBots={() => {
              // Bot编辑完成后，不直接修改props，而是关闭抽屉
              // 用户可以通过刷新页面获取最新的bots数据
              message.success('Bot已更新，请刷新页面查看最新数据');
            }}
            editingBotId={editingBotId}
            setEditingBotId={(id) => {
              setEditingBotId(id);
              if (id === null) {
                setEditingBotDrawerVisible(false);
              }
            }}
            message={message}
          />
        )}
      </Drawer>
    </div>
  )
}