export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
  version: number;
  open_issues: number;
  closed_issues: number;
  archived_issues?: number;
}

export interface MilestoneInput {
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
}

export interface MilestonesApi {
  getCacheScope?(): unknown;
  list(projectId: string): Promise<Milestone[]>;
  create(projectId: string, input: MilestoneInput): Promise<Milestone>;
  update(
    projectId: string,
    id: string,
    input: MilestoneInput & { version: number },
  ): Promise<Milestone>;
  remove(projectId: string, id: string, version: number): Promise<void>;
}
