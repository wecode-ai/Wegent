export interface CollaborationIssueTiming {
  issue_id: string;
  start: string;
  end: string;
  wall_seconds: number;
  ai_active_seconds: number;
  non_ai_seconds: number;
  agent_run_seconds: number;
  observed_ai_share: number | null;
  partial: boolean;
  unknown_terminal_runs: number;
  run_statuses: Record<string, number>;
  per_person: Record<
    string,
    {
      ai_active_seconds: number;
      agent_run_seconds: number;
      denominator: number;
      share: number | null;
    }
  >;
}

export interface CollaborationMetrics {
  definition_version: number;
  project_id?: string;
  user_id?: number;
  denominator_definition?: string;
  projects?: { project_id: string; completed: number }[];
  as_of: string;
  window: { start: string; end: string; days: number };
  completion: {
    completed: number;
    denominator: number;
    sample: number;
    per_member: number | null;
    unknown: number;
    per_person: Record<string, number>;
  };
  timing: {
    wall_seconds: number;
    ai_active_seconds: number;
    non_ai_seconds: number;
    agent_run_seconds: number;
    observed_ai_share: number | null;
    denominator: number;
    sample: number;
    partial: boolean;
    issues?: CollaborationIssueTiming[];
  };
}

export interface CollaborationMetricsApi {
  project(projectId: string): Promise<CollaborationMetrics>;
  personal(): Promise<CollaborationMetrics>;
}
