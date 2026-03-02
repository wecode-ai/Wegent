# Optimize Exam Sessions Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize the exam sessions management page to support force-ending sessions with grading task trigger, flexible phase transitions, and improved UI with topic info at the top.

**Architecture:** Refactor backend API to return topic info separately from sessions list, enhance phase update endpoint to support any state transition, and ensure grading tasks are triggered when transitioning to completed state. Frontend will be updated to show topic header and simplified session cards with phase management controls.

**Tech Stack:** FastAPI (backend), Next.js 15 + TypeScript + React 19 + shadcn/ui (frontend), SQLAlchemy, MySQL

---

## Task 1: Create New Git Branch

**Files:**
- Command: git branch operations

**Step 1: Check existing branches and create new branch**

```bash
# Get all remote branches starting with wegent/
git branch -r | grep "wegent/" | head -20

# Create and checkout new branch
git checkout -b wegent/optimize-exam-sessions-management
```

**Step 2: Verify branch created**

```bash
git branch --show-current
# Expected: wegent/optimize-exam-sessions-management
```

---

## Task 2: Backend - Optimize GET /exam-sessions Endpoint

**Files:**
- Modify: `backend/wecode/api/evaluation/author.py:1073-1131`

**Step 1: Update the endpoint to return topic info separately**

Modify the `get_topic_exam_sessions` function to return topic info at the top level:

```python
@router.get("/topics/{topic_id}/exam-sessions")
def get_topic_exam_sessions(
    topic_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all exam sessions for a topic (author only).

    Returns session information including:
    - Topic info (at top level, not repeated per session)
    - User sessions list (simplified, without redundant topic data)
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    # Check if topic has examMode enabled
    extra_data = topic.extra_data or {}
    if not extra_data.get("examMode"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This topic is not configured for exam mode",
        )

    from app.models.user import User
    from wecode.models.evaluation_exam_session import EvalExamSession

    sessions = (
        db.query(EvalExamSession, User)
        .join(User, EvalExamSession.user_id == User.id)
        .filter(
            EvalExamSession.topic_id == topic_id,
            EvalExamSession.is_active == 1,
        )
        .all()
    )

    # Build simplified session list without redundant topic data
    session_list = []
    for session, user in sessions:
        session_list.append({
            "user_id": session.user_id,
            "user_name": user.user_name if user else f"User {session.user_id}",
            "user_email": user.email if user else None,
            "current_phase": session.current_phase,
            "started_at": session.started_at.isoformat() if session.started_at else None,
            "submit_count": session.submit_count,
            "selected_question_id": session.selected_question_id or None,
        })

    # Return topic info at top level + simplified sessions list
    return {
        "topic": {
            "id": topic.id,
            "name": topic.name,
            "description": extra_data.get("description"),
            "exam_mode": True,
            "intro_duration_minutes": extra_data.get("introDurationMinutes", 5),
            "exam_duration_minutes": extra_data.get("examDurationMinutes", 50),
            "review_duration_minutes": extra_data.get("reviewDurationMinutes", 5),
        },
        "sessions": session_list,
        "total": len(session_list),
    }
```

**Step 2: Test the endpoint**

Run: `curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/evaluation/author/topics/1/exam-sessions`

Expected: Response with `topic` object at top level and simplified `sessions` array

---

## Task 3: Backend - Enhance Update Phase Endpoint

**Files:**
- Modify: `backend/wecode/api/evaluation/author.py:1154-1239`

**Step 1: Update the UpdateSessionPhaseRequest schema**

```python
class UpdateSessionPhaseRequest(BaseModel):
    """Schema for updating exam session phase (author only)."""

    target_phase: str = Field(
        ..., description="Target phase to set (intro, exam, review, completed)"
    )
    force: bool = Field(
        default=False, description="Force transition even if not in valid sequence"
    )
```

**Step 2: Update the update_user_exam_session_phase endpoint**

Replace the existing endpoint (lines 1162-1239) with:

```python
@router.post("/topics/{topic_id}/exam-sessions/{user_id}/update-phase")
def update_user_exam_session_phase(
    topic_id: int,
    user_id: int,
    request: UpdateSessionPhaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update exam session phase for a user (author only).

    This allows the topic author to manually control a user's exam session state:
    - intro: Initial phase
    - exam: Exam answering phase
    - review: Review phase
    - completed: Completed (triggers grading task creation)

    By default, only valid transitions are allowed. Set force=true to allow any transition.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()

    # Get user's active session
    session = exam_session_service.get_active_session(db, topic_id, user_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active exam session found for this user",
        )

    # Validate target phase
    valid_phases = ["intro", "exam", "review", "completed"]
    if request.target_phase not in valid_phases:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid phase. Must be one of: {', '.join(valid_phases)}",
        )

    previous_phase = session.current_phase

    # Check if transition is valid (unless force=true)
    if not request.force:
        valid_transitions = {
            "intro": ["exam"],
            "exam": ["review", "completed"],  # Allow skip to completed
            "review": ["completed"],
            "completed": [],
        }
        if request.target_phase not in valid_transitions.get(previous_phase, []):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot transition from '{previous_phase}' to '{request.target_phase}'. "
                f"Use force=true to override.",
            )

    # Update phase using service method
    exam_session_service.update_session_phase(
        db=db,
        session=session,
        target_phase=request.target_phase,
    )

    # If transitioning to completed, create grading tasks
    if request.target_phase == "completed":
        from wecode.api.evaluation.respondent import _create_grading_tasks_for_exam_completion

        _create_grading_tasks_for_exam_completion(
            db=db,
            topic_id=topic_id,
            user_id=user_id,
            topic=topic,
        )

    return {
        "success": True,
        "message": f"Session phase updated from '{previous_phase}' to '{request.target_phase}'",
        "previous_phase": previous_phase,
        "current_phase": request.target_phase,
        "user_id": user_id,
    }
```

---

## Task 4: Backend - Add update_session_phase Service Method

**Files:**
- Modify: `backend/wecode/service/evaluation/exam_session_service.py:348-349`

**Step 1: Add the new method to ExamSessionService**

Add after the `advance_phase` method:

```python
    @staticmethod
    def update_session_phase(
        db: Session, session: EvalExamSession, target_phase: str
    ) -> EvalExamSession:
        """Update session phase to any valid phase (for admin use).

        Unlike advance_phase which only allows forward transitions,
        this method allows setting phase to any valid value.

        Args:
            db: Database session
            session: Current exam session
            target_phase: Target phase to set

        Returns:
            Updated exam session
        """
        extra = session.extra_data or {}
        now_ts = int(time.time())

        # Set phase-specific start times when transitioning to certain phases
        if target_phase == "exam" and not extra.get("exam_started_at"):
            extra["exam_started_at"] = now_ts
        elif target_phase == "review" and not extra.get("review_started_at"):
            extra["review_started_at"] = now_ts

        session.current_phase = target_phase
        session.extra_data = extra
        from sqlalchemy.orm import attributes

        attributes.flag_modified(session, "extra_data")
        db.commit()
        db.refresh(session)

        return session
```

---

## Task 5: Backend - Add Force End Session Endpoint

**Files:**
- Modify: `backend/wecode/api/evaluation/author.py` (add after update-phase endpoint)

**Step 1: Add the force end endpoint**

Add after the update_user_exam_session_phase endpoint:

```python
@router.post("/topics/{topic_id}/exam-sessions/{user_id}/force-end")
def force_end_exam_session(
    topic_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Force end a user's exam session and trigger grading (author only).

    This immediately sets the session to 'completed' and creates grading tasks
    for all submitted answers. Useful when a user abandons the exam or
    encounters technical issues.
    """
    topic = _get_topic_or_404(db, topic_id)
    _verify_topic_ownership(db, topic, current_user.id)

    exam_session_service = get_exam_session_service()

    # Get user's active session
    session = exam_session_service.get_active_session(db, topic_id, user_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active exam session found for this user",
        )

    # Cannot force-end an already completed session
    if session.current_phase == "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Session is already completed",
        )

    previous_phase = session.current_phase

    # Update to completed phase
    exam_session_service.update_session_phase(
        db=db,
        session=session,
        target_phase="completed",
    )

    # Create grading tasks
    from wecode.api.evaluation.respondent import _create_grading_tasks_for_exam_completion

    _create_grading_tasks_for_exam_completion(
        db=db,
        topic_id=topic_id,
        user_id=user_id,
        topic=topic,
    )

    return {
        "success": True,
        "message": f"Session force-ended (was: {previous_phase}) and grading tasks created",
        "previous_phase": previous_phase,
        "current_phase": "completed",
        "user_id": user_id,
    }
```

---

## Task 6: Frontend - Update API Types and Client

**Files:**
- Modify: `frontend/wecode/api/evaluation-author.ts:376-435`

**Step 1: Update ExamSession interface**

```typescript
export interface ExamSession {
  user_id: number
  user_name?: string
  user_email?: string
  current_phase: 'intro' | 'exam' | 'review' | 'completed'
  started_at: string | null
  submit_count: number
  selected_question_id: number | null
}

export interface ExamTopicInfo {
  id: number
  name: string
  description?: string
  exam_mode: boolean
  intro_duration_minutes: number
  exam_duration_minutes: number
  review_duration_minutes: number
}

export interface ExamSessionListResponse {
  topic: ExamTopicInfo
  sessions: ExamSession[]
  total: number
}
```

**Step 2: Add new API functions**

Add after `resetUserExamSession`:

```typescript
export async function updateUserExamSessionPhase(
  topicId: number,
  userId: number,
  targetPhase: 'intro' | 'exam' | 'review' | 'completed',
  force?: boolean
): Promise<{
  success: boolean
  message: string
  previous_phase: string
  current_phase: string
  user_id: number
}> {
  return fetchJson<{
    success: boolean
    message: string
    previous_phase: string
    current_phase: string
    user_id: number
  }>(getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/update-phase`), {
    method: 'POST',
    body: JSON.stringify({ target_phase: targetPhase, force }),
  })
}

export async function forceEndExamSession(
  topicId: number,
  userId: number
): Promise<{
  success: boolean
  message: string
  previous_phase: string
  current_phase: string
  user_id: number
}> {
  return fetchJson<{
    success: boolean
    message: string
    previous_phase: string
    current_phase: string
    user_id: number
  }>(getAuthorUrl(`/topics/${topicId}/exam-sessions/${userId}/force-end`), {
    method: 'POST',
  })
}
```

---

## Task 7: Frontend - Refactor Exam Sessions Page

**Files:**
- Modify: `frontend/src/app/(tasks)/evaluation/author/topics/[id]/exam-sessions/page.tsx`

**Step 1: Update imports**

```typescript
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
  Power,
  MoreVertical,
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
} from '@/components/ui/dropdown-menu'
```

**Step 2: Update SessionCard component**

Replace the SessionCard component with a simplified version that includes phase management:

```typescript
interface SessionCardProps {
  session: ExamSession
  onReset: (session: ExamSession) => void
  onPhaseChange: (session: ExamSession, phase: string) => void
  onForceEnd: (session: ExamSession) => void
}

const PHASE_OPTIONS = [
  { value: 'intro', label: '介绍中', color: 'blue' },
  { value: 'exam', label: '考试中', color: 'emerald' },
  { value: 'review', label: '检查中', color: 'orange' },
  { value: 'completed', label: '已完成', color: 'gray' },
]

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
                  <DropdownMenuItem
                    onClick={() => onForceEnd(session)}
                    className="text-orange-600"
                  >
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
```

**Step 3: Update main component**

Replace the main component with the refactored version that includes topic header:

```typescript
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
                <Badge variant="outline" className="border-blue-200 text-blue-700">
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
                <p className="mt-2 text-sm text-gray-500">此操作不可撤销。</p>
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
                的会话状态更改为 <strong>{PHASE_OPTIONS.find(p => p.value === targetPhase)?.label}</strong>。
                {targetPhase === 'completed' && (
                  <p className="mt-2 text-orange-600">注意：设为完成后将自动创建评分任务。</p>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handlePhaseChangeConfirm}>
                确认更改
              </AlertDialogAction>
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
                <p className="mt-2 text-sm text-gray-500">此操作不可撤销，仅在考生放弃考试或遇到技术问题时使用。</p>
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
```

---

## Task 8: Commit Changes

**Step 1: Stage and commit backend changes**

```bash
git add backend/
git commit -m "feat(backend): optimize exam session management API

- Refactor GET /exam-sessions to return topic info separately
- Add update_session_phase service method for flexible phase transitions
- Enhance update-phase endpoint to support force transitions
- Add force-end endpoint to immediately complete session and trigger grading
- Ensure grading tasks are created when transitioning to completed state"
```

**Step 2: Stage and commit frontend changes**

```bash
git add frontend/
git commit -m "feat(frontend): optimize exam sessions management page

- Add topic info header card at the top of the page
- Simplify session cards by removing redundant information
- Add dropdown menu for phase management (support any state transition)
- Add force-end session functionality with confirmation dialog
- Update API types and client functions for new endpoints"
```

---

## Task 9: Push Branch and Create MR

**Step 1: Push branch to remote**

```bash
git push -u origin wegent/optimize-exam-sessions-management
```

**Step 2: Create MR using glab**

```bash
# Get target branch from environment
TARGET_BRANCH="${BRANCH_NAME:-main}"

glab mr create \
  --title "feat: optimize exam sessions management" \
  --description "$(cat <<'EOF'
## Summary

优化考试会话管理页面，支持强制结束会话并触发评分任务，以及灵活的状态管理。

## Changes

### Backend
- 优化 GET /exam-sessions 接口，将专题信息放在顶层返回，简化会话列表数据
- 增强 update-phase 接口，支持强制状态跳转（force 参数）
- 新增 force-end 接口，用于强制结束会话并触发评分任务
- 确保状态变为 completed 时自动创建评分任务
- 新增 update_session_phase 服务方法，支持任意状态过渡

### Frontend
- 在页面顶部添加专题信息卡片展示
- 简化会话卡片，移除重复信息
- 添加下拉菜单支持任意状态更新
- 添加强制结束会话功能
- 更新 API 类型定义和客户端函数

## Test plan

- [ ] 验证 GET /exam-sessions 返回正确的 topic 和 sessions 结构
- [ ] 验证 update-phase 接口支持正常和强制状态跳转
- [ ] 验证 force-end 接口正确结束会话并创建评分任务
- [ ] 验证页面顶部正确显示专题信息
- [ ] 验证会话卡片简化后信息完整
- [ ] 验证状态更新下拉菜单正常工作
- [ ] 验证强制结束会话功能正常工作
EOF
)" \
  --target-branch "$TARGET_BRANCH"
```

---

## Summary

This implementation plan covers:

1. **Backend optimizations:**
   - Refactored GET endpoint to return topic info separately
   - Enhanced phase update with force option
   - Added force-end endpoint
   - Ensured grading task creation on completed state

2. **Frontend optimizations:**
   - Added topic header card
   - Simplified session cards
   - Added phase management dropdown
   - Added force-end functionality

3. **Code quality:**
   - Reduced redundancy by separating topic info
   - Consistent type definitions
   - Better UX with confirmation dialogs
