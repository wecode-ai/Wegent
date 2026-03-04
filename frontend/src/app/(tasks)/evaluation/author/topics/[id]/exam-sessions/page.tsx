// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Users, RotateCcw, AlertCircle, Power, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { ExamTimerDisplay } from '@wecode/components/evaluation/common/ExamTimerDisplay'
import {
  getTopicExamSessions,
  resetUserExamSession,
  updateUserExamSessionPhase,
  forceEndExamSession,
  type ExamSession,
  type ExamTopicInfo,
} from '@wecode/api/evaluation-author'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'

const PHASE_OPTIONS = [
  { value: 'intro', label: '介绍中', color: 'blue' },
  { value: 'exam', label: '考试中', color: 'emerald' },
  { value: 'review', label: '检查中', color: 'orange' },
  { value: 'completed', label: '已完成', color: 'gray' },
]

interface SessionCardProps {
  session: ExamSession
  onReset: (session: ExamSession) => void
  onPhaseChange: (session: ExamSession, phase: string) => void
  onForceEnd: (session: ExamSession) => void
}

function SessionCard({ session, onReset, onPhaseChange, onForceEnd }: SessionCardProps) {
  const getPhaseBadge = (phase: string) => {
    const option = PHASE_OPTIONS.find(p => p.value === phase) || PHASE_OPTIONS[0]
    const colorClasses: Record<string, string> = {
      blue: 'bg-blue-100 text-blue-700',
      emerald: 'bg-emerald-100 text-emerald-700',
      orange: 'bg-orange-100 text-orange-700',
      gray: 'bg-gray-100 text-gray-700',
    }

    return (
      <Badge className={`${colorClasses[option.color]} hover:${colorClasses[option.color]}`}>
        {option.label}
      </Badge>
    )
  }

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="w-4 h-4 text-gray-400" />
            <div>
              <span className="font-medium text-gray-900">
                {session.user_name || `用户 #${session.user_id}`}
              </span>
              {session.user_email && (
                <span className="text-sm text-gray-400 ml-2">({session.user_email})</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {session.current_phase === 'exam' && (
              <ExamTimerDisplay
                initialRemainingSeconds={session.remaining_seconds}
                phase={session.current_phase}
                size="sm"
              />
            )}
            {getPhaseBadge(session.current_phase)}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled className="text-xs text-gray-500">
                  更改状态
                </DropdownMenuItem>
                {PHASE_OPTIONS.map(option => (
                  <DropdownMenuItem
                    key={option.value}
                    disabled={session.current_phase === option.value}
                    onClick={() => onPhaseChange(session, option.value)}
                  >
                    设为{option.label}
                    {session.current_phase === option.value && ' (当前)'}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem disabled className="text-xs text-gray-500 mt-2">
                  操作
                </DropdownMenuItem>
                {session.current_phase !== 'completed' && (
                  <DropdownMenuItem onClick={() => onForceEnd(session)} className="text-orange-600">
                    <Power className="w-4 h-4 mr-2" />
                    强制结束
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onReset(session)} className="text-red-600">
                  <RotateCcw className="w-4 h-4 mr-2" />
                  重置会话
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-6 text-sm text-gray-500">
          <span>提交次数: {session.submit_count}</span>
          {session.selected_question_id ? (
            <span>已选题目: ID {session.selected_question_id}</span>
          ) : (
            <span className="text-orange-500">未选择题目</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default function ExamSessionsPage() {
  const router = useRouter()
  const params = useParams()
  const topicId = Number(params.id)
  const { toast } = useToast()

  const [topic, setTopic] = useState<ExamTopicInfo | null>(null)
  const [sessions, setSessions] = useState<ExamSession[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')

  // Dialog states
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [forceEndDialogOpen, setForceEndDialogOpen] = useState(false)
  const [phaseDialogOpen, setPhaseDialogOpen] = useState(false)
  const [selectedSession, setSelectedSession] = useState<ExamSession | null>(null)
  const [targetPhase, setTargetPhase] = useState<string>('')

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getTopicExamSessions(topicId, {
        page: 1,
        limit: 100,
      })
      setTopic(response.topic)
      setSessions(response.sessions || [])
    } catch (_error) {
      toast({
        title: '加载失败',
        description: '无法加载考试会话列表',
        variant: 'destructive',
      })
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [topicId, toast])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const handleResetClick = (session: ExamSession) => {
    setSelectedSession(session)
    setResetDialogOpen(true)
  }

  const handleResetConfirm = async () => {
    if (!selectedSession) return

    try {
      await resetUserExamSession(topicId, selectedSession.user_id)
      toast({
        title: '重置成功',
        description: `已重置 ${selectedSession.user_name || `用户 #${selectedSession.user_id}`} 的考试会话`,
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: '重置失败',
        description: '无法重置考试会话',
        variant: 'destructive',
      })
    } finally {
      setResetDialogOpen(false)
      setSelectedSession(null)
    }
  }

  const handlePhaseChangeClick = (session: ExamSession, phase: string) => {
    setSelectedSession(session)
    setTargetPhase(phase)
    setPhaseDialogOpen(true)
  }

  const handlePhaseChangeConfirm = async () => {
    if (!selectedSession || !targetPhase) return

    try {
      const result = await updateUserExamSessionPhase(
        topicId,
        selectedSession.user_id,
        targetPhase as 'intro' | 'exam' | 'review' | 'completed',
        true
      )
      toast({
        title: '状态更新成功',
        description: result.message,
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: '状态更新失败',
        description: '无法更新会话状态',
        variant: 'destructive',
      })
    } finally {
      setPhaseDialogOpen(false)
      setSelectedSession(null)
      setTargetPhase('')
    }
  }

  const handleForceEndClick = (session: ExamSession) => {
    setSelectedSession(session)
    setForceEndDialogOpen(true)
  }

  const handleForceEndConfirm = async () => {
    if (!selectedSession) return

    try {
      const result = await forceEndExamSession(topicId, selectedSession.user_id)
      toast({
        title: '强制结束成功',
        description: result.message,
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: '操作失败',
        description: '无法强制结束会话',
        variant: 'destructive',
      })
    } finally {
      setForceEndDialogOpen(false)
      setSelectedSession(null)
    }
  }

  const filteredSessions = sessions.filter(session => {
    if (activeTab === 'all') return true
    return session.current_phase === activeTab
  })

  const stats = {
    total: sessions.length,
    intro: sessions.filter(s => s.current_phase === 'intro').length,
    exam: sessions.filter(s => s.current_phase === 'exam').length,
    review: sessions.filter(s => s.current_phase === 'review').length,
    completed: sessions.filter(s => s.current_phase === 'completed').length,
  }

  return (
    <EvaluationPageLayout>
      <div className="max-w-5xl mx-auto">
        {/* Header with back button */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">考试会话管理</h1>
            <p className="text-sm text-gray-500">查看和管理考生的考试会话状态</p>
          </div>
        </div>

        {/* Topic Info Card */}
        {topic && (
          <Card className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-100">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{topic.name}</h2>
                  {topic.description && (
                    <p className="text-sm text-gray-600 mt-1">{topic.description}</p>
                  )}
                </div>
                <Badge variant="info" className="border-blue-200 text-blue-700">
                  考试模式
                </Badge>
              </div>
              <div className="mt-4 flex items-center gap-6 text-sm text-gray-600">
                <span>介绍: {topic.intro_duration_minutes}分钟</span>
                <span>考试: {topic.exam_duration_minutes}分钟</span>
                <span>检查: {topic.review_duration_minutes}分钟</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
              <div className="text-sm text-gray-500">总会话</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-blue-600">{stats.intro}</div>
              <div className="text-sm text-gray-500">介绍中</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-emerald-600">{stats.exam}</div>
              <div className="text-sm text-gray-500">考试中</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-orange-600">{stats.review}</div>
              <div className="text-sm text-gray-500">检查中</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-gray-600">{stats.completed}</div>
              <div className="text-sm text-gray-500">已完成</div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="intro">介绍中</TabsTrigger>
            <TabsTrigger value="exam">考试中</TabsTrigger>
            <TabsTrigger value="review">检查中</TabsTrigger>
            <TabsTrigger value="completed">已完成</TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab} className="space-y-4">
            {loading ? (
              // Loading skeletons
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-5 w-48" />
                  </CardContent>
                </Card>
              ))
            ) : filteredSessions.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">暂无考试会话</p>
                  <p className="text-sm text-gray-400 mt-1">考生开始考试后，会话将显示在这里</p>
                </CardContent>
              </Card>
            ) : (
              filteredSessions.map(session => (
                <SessionCard
                  key={session.user_id}
                  session={session}
                  onReset={handleResetClick}
                  onPhaseChange={handlePhaseChangeClick}
                  onForceEnd={handleForceEndClick}
                />
              ))
            )}
          </TabsContent>
        </Tabs>

        {/* Reset Confirmation Dialog */}
        <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认重置考试会话?</AlertDialogTitle>
              <AlertDialogDescription>
                这将重置{' '}
                <strong>{selectedSession?.user_name || `用户 #${selectedSession?.user_id}`}</strong>{' '}
                的考试会话，考生需要重新开始考试。
                <span className="mt-2 block text-sm text-gray-500">此操作不可撤销。</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleResetConfirm}
                className="bg-red-600 hover:bg-red-700"
              >
                确认重置
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Phase Change Confirmation Dialog */}
        <AlertDialog open={phaseDialogOpen} onOpenChange={setPhaseDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认更改会话状态?</AlertDialogTitle>
              <AlertDialogDescription>
                将{' '}
                <strong>{selectedSession?.user_name || `用户 #${selectedSession?.user_id}`}</strong>{' '}
                的会话状态更改为{' '}
                <strong>{PHASE_OPTIONS.find(p => p.value === targetPhase)?.label}</strong>。
                {targetPhase === 'completed' && (
                  <span className="mt-2 block text-orange-600">
                    注意：设为完成后将自动创建评分任务。
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handlePhaseChangeConfirm}>确认更改</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Force End Confirmation Dialog */}
        <AlertDialog open={forceEndDialogOpen} onOpenChange={setForceEndDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认强制结束会话?</AlertDialogTitle>
              <AlertDialogDescription>
                这将立即结束{' '}
                <strong>{selectedSession?.user_name || `用户 #${selectedSession?.user_id}`}</strong>{' '}
                的考试，并创建评分任务。
                <span className="mt-2 block text-sm text-gray-500">
                  此操作不可撤销，仅在考生放弃考试或遇到技术问题时使用。
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleForceEndConfirm}
                className="bg-orange-600 hover:bg-orange-700"
              >
                强制结束
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </EvaluationPageLayout>
  )
}
