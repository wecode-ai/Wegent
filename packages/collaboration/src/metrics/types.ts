export type MetricFact =
  | {
      kind: 'contribution'
      user_id: number | null
      basis: 'delivery' | 'completed_stage' | 'formal_review'
      effective_at: string
      revoked: boolean
    }
  | {
      kind: 'activity'
      agent_id: string
      run_id: string
      owner_user_id: number | null
      started_at: string
      ended_at: string | null
      state: 'active' | 'queue' | 'approval' | 'offline' | 'child_wait'
      outcome: 'running' | 'completed' | 'failed' | 'cancelled'
    }
  | {
      kind: 'unit'
      unit_id: string
      content_version: string
      accepted_version: string | null
      accepted_at: string | null
      classification: 'ai' | 'mixed' | 'human' | 'unknown'
      contributors: number[]
    }
  | {
      kind: 'handoff'
      ready_at: string
      started_at: string | null
      wait_type: 'queue' | 'judgment' | 'external'
      owner_user_id: number | null
    }
  | {
      kind: 'capacity'
      user_id: number
      calendar_id: string
      available_seconds: number
      member_from: string
      member_until: string
    }

export interface CollaborationMetricEvidence {
  key: string
  revision: number
  issue_id: string
  references: string[]
  fact: MetricFact
}

export interface CollaborationMetricReceipt {
  receipt_id: string
  event_type: 'metric_evidence'
  definition_version: 'collab-v2'
  reported_by_user_id: number
  recorded_at: string
  record: CollaborationMetricEvidence
}

export interface CollaborationMetrics {
  definition_version: 'collab-v2'
  project_id?: string
  user_id?: number
  denominator_definition: 'current_effective_members_participation'
  projects?: { project_id: string; completed: number }[]
  member_snapshot: number[]
  unavailable_evidence: Partial<Record<MetricFact['kind'], number>>
  as_of: string
  window: { start: string; end: string; days: number }
  completion: {
    completed: number
    numerator: number
    denominator: number
    sample: number
    per_member: number | null
    unknown: number
    unknown_evidence?: number
    per_person: Record<string, number>
    issues: {
      issue_id: string
      completed_at: string
      participants: number[]
      references: string[]
      reopened: boolean
    }[]
  }
  activity: {
    ai_active_seconds: number
    ai_active_hours: number
    per_person_seconds: Record<string, number>
    denominator: number | null
    runtime_to_capacity_ratio: number | null
    ratio_definition: 'runtime_hours_per_available_human_hour'
    capacity: {
      seconds: number | null
      partial: boolean
      intervals: {
        user_id: number
        calendar_id: string
        start: string
        end: string
        available_seconds: number
      }[]
    }
    sample: number
    partial: boolean
    intervals: {
      key: string
      issue_id: string
      agent_id: string
      run_id: string
      owner_user_id: number | null
      start: string
      end: string
      state: string
      outcome: string
      partial: boolean
    }[]
  }
  delivery: {
    counts: Record<'ai' | 'mixed' | 'human' | 'unknown', number>
    numerator: number
    denominator: number
    sample: number
    ai_independent_share: number | null
    units: {
      key: string
      issue_id: string
      fact: Extract<MetricFact, { kind: 'unit' }>
    }[]
  }
  cycle: {
    p50_seconds: number | null
    p90_seconds: number | null
    sample: number
    issues: { issue_id: string; start: string; end: string; seconds: number }[]
  }
  handoff: {
    partial?: boolean
    queue_p50_seconds: number | null
    sample: number
    backlog: number
    longest_wait_seconds: number
    started: {
      key: string
      issue_id: string
      ready_at: string
      started_at: string
      seconds: number
      wait_type: string
    }[]
    pending: {
      key: string
      issue_id: string
      ready_at: string
      waiting_seconds: number
      wait_type: string
    }[]
  }
  evidence: CollaborationMetricEvidence[]
}

export interface CollaborationMetricsApi {
  project(projectId: string): Promise<CollaborationMetrics>
  personal(): Promise<CollaborationMetrics>
  recordEvidence(
    projectId: string,
    record: CollaborationMetricEvidence
  ): Promise<CollaborationMetricReceipt>
}
