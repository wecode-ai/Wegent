// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  Users,
  Clock,
  RotateCcw,
  CheckCircle,
  AlertCircle,
  PlayCircle,
  Timer,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getTopicExamSessions,
  resetUserExamSession,
  type ExamSession,
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

// Helper function to get phase from session
const getSessionPhase = (s: ExamSession): string => {
  return s.current_phase || s.phase || 'intro'
}

interface SessionCardProps {
  session: ExamSession
  onReset: (session: ExamSession) => void
}

function SessionCard({ session, onReset }: SessionCardProps) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getPhaseBadge = (phase: string) => {
    switch (phase) {
      case 'intro':
        return (
          <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">
            <PlayCircle className="w-3 h-3 mr-1" />
            介绍中
          </Badge>
        )
      case 'exam':
        return (
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
            <PlayCircle className="w-3 h-3 mr-1" />
            考试中
          </Badge>
        )
      case 'review':
        return (
          <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">
            <Clock className="w-3 h-3 mr-1" />
            检查中
          </Badge>
        )
      case 'completed':
        return (
          <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100">
            <CheckCircle className="w-3 h-3 mr-1" />
            已完成
          </Badge>
        )
      default:
        return <Badge variant="secondary">{phase}</Badge>
    }
  }

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-gray-400" />
              <span className="font-medium text-gray-900">
                {session.user_name || `用户 #${session.user_id}`}
              </span>
              {session.user_email && (
                <span className="text-sm text-gray-400">({session.user_email})</span>
              )}
            </div>
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>开始时间: {formatDate(session.started_at)}</span>
              <span>提交次数: {session.submit_count}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {getPhaseBadge(getSessionPhase(session))}
            {getSessionPhase(session) !== 'completed' &&
              session.remaining_seconds !== undefined && (
                <div
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-mono ${
                    (session.remaining_seconds || 0) <= 300
                      ? 'bg-red-100 text-red-700'
                      : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  <Timer className="w-3 h-3" />
                  {formatTime(session.remaining_seconds || 0)}
                </div>
              )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
          <div className="text-sm text-gray-500">
            {session.selected_question_id ? (
              <span>已选题目: ID {session.selected_question_id}</span>
            ) : (
              <span className="text-orange-500">未选择题目</span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => onReset(session)}>
            <RotateCcw className="w-4 h-4 mr-1" />
            重置会话
          </Button>
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

  const [sessions, setSessions] = useState<ExamSession[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [selectedSession, setSelectedSession] = useState<ExamSession | null>(null)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const phase = activeTab === 'all' ? undefined : activeTab
      const response = await getTopicExamSessions(topicId, {
        page: 1,
        limit: 100,
        phase,
      })
      // Handle both {sessions: []} and {items: []} response formats
      const sessionList = response?.sessions || response?.items || response || []
      setSessions(Array.isArray(sessionList) ? sessionList : [])
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
  }, [topicId, activeTab, toast])

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

  const stats = {
    total: sessions.length,
    intro: sessions.filter(s => getSessionPhase(s) === 'intro').length,
    exam: sessions.filter(s => getSessionPhase(s) === 'exam').length,
    review: sessions.filter(s => getSessionPhase(s) === 'review').length,
    completed: sessions.filter(s => getSessionPhase(s) === 'completed').length,
  }

  return (
    <EvaluationPageLayout>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">考试会话管理</h1>
            <p className="text-sm text-gray-500">查看和管理考生的考试会话状态</p>
          </div>
        </div>

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
                  <CardContent className="p-5">
                    <div className="space-y-3">
                      <Skeleton className="h-5 w-48" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : sessions.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">暂无考试会话</p>
                  <p className="text-sm text-gray-400 mt-1">考生开始考试后，会话将显示在这里</p>
                </CardContent>
              </Card>
            ) : (
              sessions.map(session => (
                <SessionCard key={session.id} session={session} onReset={handleResetClick} />
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
                的考试会话，包括:
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>考试计时器将重新开始</li>
                  <li>已提交答案将被保留但可重新提交</li>
                  <li>考生需要重新进入考试</li>
                </ul>
                此操作不可撤销。
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
      </div>
    </EvaluationPageLayout>
  )
}
