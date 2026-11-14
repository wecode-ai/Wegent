import { useIssueProjectChat } from '@wegent/collaboration'
import type { IssueParticipationViewer, SharedWorkspaceApi } from '@wegent/collaboration'
import type { RuntimeWorkListResponse } from '@/types/api'
import { selectPrivateConversations, selectTaskTimeline } from '../model'
import type { ExperienceConversationSelection, ExperienceTimeline } from '../model'
import type { ExperienceIssueData } from './useExperienceIssue'
import { invalidatesExperienceRead } from './useExperienceSourceReads'

export interface ExperienceTimelineData {
  timeline: ExperienceTimeline
  conversations: ExperienceConversationSelection
  loading: boolean
  error: string | null
}

export function useExperienceTimeline(
  api: SharedWorkspaceApi | undefined,
  data: ExperienceIssueData | null,
  viewer: IssueParticipationViewer,
  runtimeWork: RuntimeWorkListResponse | null,
  active: boolean,
  revision: number
): ExperienceTimelineData {
  const chat = useIssueProjectChat(
    active && data ? api?.activity : undefined,
    data?.project.id ?? '',
    data?.issue.id ?? '',
    revision,
    invalidatesExperienceRead
  )
  if (!data)
    return {
      timeline: { state: 'unknown', nodes: [] },
      conversations: { state: 'unknown', items: [] },
      loading: false,
      error: null,
    }
  const input = {
    ...data,
    viewer,
    runtimeWork,
    messages: chat.ready && api?.activity ? chat.messages : null,
  }
  return {
    timeline: selectTaskTimeline(input),
    conversations: selectPrivateConversations(input),
    loading: chat.loading,
    error: chat.error,
  }
}
