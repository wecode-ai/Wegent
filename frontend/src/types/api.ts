// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Authentication Types

// User Preferences
export interface QuickAccessConfig {
  version?: number; // User's synced system version
  teams: number[]; // User's selected team IDs (excluding system recommended)
}

export interface UserPreferences {
  send_key: 'enter' | 'cmd_enter';
  quick_access?: QuickAccessConfig;
}

// User Types
export type UserRole = 'admin' | 'user';
export type AuthSource = 'password' | 'oidc' | 'unknown';

export interface User {
  id: number;
  user_name: string;
  email: string;
  is_active: boolean;
  role?: UserRole;
  auth_source?: AuthSource;
  created_at: string;
  updated_at: string;
  git_info: GitInfo[];
  preferences?: UserPreferences;
}

/** Git account information */
export interface GitInfo {
  /** Unique identifier for this git info entry (UUID) */
  id?: string;
  git_domain: string;
  git_token: string;
  /** Type: "github" | "gitlab" | "gitee" | "gitea" | "gerrit" */
  type: 'github' | 'gitlab' | 'gitee' | 'gitea' | 'gerrit';
  /** Username (required for Gerrit) */
  user_name?: string;
  /** Git user ID (from provider) */
  git_id?: string;
  /** Git login name */
  git_login?: string;
  /** Git email */
  git_email?: string;
}

// Bot Types
export interface Bot {
  id: number;
  name: string;
  shell_name: string; // Shell name user selected (e.g., 'ClaudeCode', 'my-custom-shell')
  shell_type: string; // Actual agent type (e.g., 'ClaudeCode', 'Agno', 'Dify')
  agent_config: Record<string, unknown>;
  system_prompt: string;
  mcp_servers: Record<string, unknown>;
  skills?: string[]; // Skills associated with this bot
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Skill Types (CRD format)
export interface SkillMetadata {
  name: string;
  namespace: string;
  labels?: Record<string, string>;
}

export interface SkillSpec {
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
}

export interface SkillStatus {
  state: 'Available' | 'Unavailable';
  fileSize?: number;
  fileHash?: string;
}

export interface Skill {
  apiVersion: string;
  kind: 'Skill';
  metadata: SkillMetadata;
  spec: SkillSpec;
  status?: SkillStatus;
}

export interface SkillList {
  items: Skill[];
}

// Shell Types
export interface Shell {
  id: number;
  name: string;
  runtime: string;
  shell_type?: 'local_engine' | 'external_api';
  support_model?: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: number;
  name: string;
  namespace?: string; // Namespace for group teams (default: 'default')
  description: string;
  bots: TeamBot[];
  workflow: Record<string, string>;
  is_active: boolean;
  user_id: number;
  created_at: string;
  updated_at: string;
  share_status?: number; // 0: 个人团队, 1: 分享中, 2: 共享团队
  agent_type?: string; // agno, claude, dify, etc.
  is_mix_team?: boolean; // true if team has multiple different agent types (e.g., ClaudeCode + Agno)
  recommended_mode?: 'chat' | 'code' | 'both'; // Recommended usage mode (for QuickAccess)
  bind_mode?: ('chat' | 'code')[]; // Allowed modes for this team
  icon?: string; // Icon ID from preset icon library
  user?: {
    user_name: string;
  };
}

/** Bot summary with only necessary fields for team list */
export interface BotSummary {
  agent_config?: Record<string, unknown>;
  shell_type?: string;
}

/** Bot information (used for Team.bots) */
export interface TeamBot {
  bot_id: number;
  bot_prompt: string;
  role?: string;
  bot?: BotSummary;
}

/** TaskDetail structure (adapted to latest backend response) */
// Task Types
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'DELETE';
export type TaskType = 'chat' | 'code';

// Git commit statistics
interface CommitStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

// Git commit information
interface GitCommit {
  commit_id: string;
  short_id: string;
  message: string;
  author: string;
  author_email: string;
  committed_date: string;
  stats: CommitStats;
}

// Git information
interface GitInfoWorkbench {
  initial_commit_id: string;
  initial_commit_message: string;
  task_commits: GitCommit[];
  source_branch: string;
  target_branch: string;
}

// File change information
interface FileChange {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  added_lines: number;
  removed_lines: number;
  diff_title: string;
}

export interface WorkbenchData {
  taskTitle: string;
  taskNumber: string;
  status: 'completed' | 'running' | 'failed';
  completedTime: string;
  repository: string;
  branch: string;
  sessions: number;
  premiumRequests: number;
  lastUpdated: string;
  summary: string;
  changes: string[];
  originalPrompt: string;
  file_changes: FileChange[];
  git_info: GitInfoWorkbench;
}

export interface OpenLinks {
  session_id: string | null;
  vscode_link: string | null;
  git_link: string | null;
  git_url: string;
  target_branch: string | null;
}

export interface TaskDetail {
  id: number;
  title: string;
  git_url: string;
  git_repo: string;
  git_repo_id: number;
  git_domain: string;
  branch_name: string;
  prompt: string;
  status: TaskStatus;
  task_type?: TaskType;
  progress: number;
  batch: number;
  result: Record<string, unknown>;
  error_message: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  user: User;
  team: Team;
  subtasks: TaskDetailSubtask[];
  workbench?: WorkbenchData | null;
  model_id?: string | null; // Model name used for this task
}

/** Subtask result structure */
export interface SubtaskResult {
  thinking?: unknown[];
  value?: string | { workbench?: WorkbenchData };
  workbench?: WorkbenchData;
  [key: string]: unknown;
}

/** Subtask structure (adapted to latest backend response) */
export interface TaskDetailSubtask {
  task_id: number;
  team_id: number;
  title: string;
  /** Multi-bot support */
  bot_ids: number[];
  /** Role */
  role: string;
  /** Message ID */
  message_id: number;
  /** Parent Task ID */
  parent_id: number;
  prompt: string;
  executor_namespace: string;
  executor_name: string;
  status: TaskStatus;
  progress: number;
  batch: number;
  result: SubtaskResult;
  error_message: string;
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  completed_at: string;
  bots: Bot[];
  attachments?: Attachment[];
}

export interface Task {
  id: number;
  title: string;
  team_id: number;
  git_url: string;
  git_repo: string;
  git_repo_id: number;
  git_domain: string;
  branch_name: string;
  prompt: string;
  status: TaskStatus;
  task_type?: TaskType;
  progress: number;
  batch: number;
  result: Record<string, unknown>;
  error_message: string;
  user_id: number;
  user_name: string;
  created_at: string;
  updated_at: string;
  completed_at: string;
}

/** GitHub repository new structure */
export interface GitRepoInfo {
  git_repo_id: number;
  name: string;
  git_repo: string;
  git_url: string;
  git_domain: string;
  private: boolean;
  /** Type: "github" | "gitlab" | "gitee" */
  type: 'github' | 'gitlab' | 'gitee';
}

export interface GitBranch {
  name: string;
  protected: boolean;
  default: boolean;
}

// Common API Response Types
export interface APIError {
  message: string;
  detail?: string;
}

export interface SuccessMessage {
  message: string;
}

// Pagination Types
export interface PaginationParams {
  page?: number;
  limit?: number;
}

// Task View Status Types
export interface TaskViewStatus {
  viewedAt: string;
  status: TaskStatus;
}

export interface TaskViewStatusMap {
  [taskId: string]: TaskViewStatus;
}

// Clarification Types
export interface ClarificationOption {
  value: string;
  label: string;
  recommended?: boolean;
}

export interface ClarificationQuestion {
  question_id: string;
  question_text: string;
  question_type: 'single_choice' | 'multiple_choice' | 'text_input';
  options?: ClarificationOption[];
}

export interface ClarificationData {
  type: 'clarification';
  questions: ClarificationQuestion[];
}

export interface ClarificationAnswer {
  question_id: string;
  question_text: string;
  answer_type: 'choice' | 'custom';
  value: string | string[];
  selected_labels?: string | string[];
}

export interface ClarificationAnswerPayload {
  type: 'clarification_answer';
  answers: ClarificationAnswer[];
}

export interface FinalPromptData {
  type: 'final_prompt';
  final_prompt: string;
}

// Dify Types
export interface DifyApp {
  id: string;
  name: string;
  mode: 'chat' | 'workflow' | 'agent' | 'chatflow';
  icon: string;
  icon_background: string;
}

export interface DifyBotPrompt {
  difyAppId?: string;
  params?: Record<string, unknown>;
}

export interface DifyParameterField {
  variable: string;
  label: string;
  type: 'text-input' | 'select' | 'paragraph';
  required?: boolean;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface DifyParametersSchema {
  user_input_form: DifyParameterField[];
}

// Attachment Types
export type AttachmentStatus = 'uploading' | 'parsing' | 'ready' | 'failed';

export interface Attachment {
  id: number;
  filename: string;
  file_size: number;
  mime_type: string;
  status: AttachmentStatus;
  text_length?: number | null;
  error_message?: string | null;
  subtask_id?: number | null;
  file_extension: string;
  created_at: string;
}

export interface AttachmentUploadState {
  file: File | null;
  attachment: Attachment | null;
  isUploading: boolean;
  uploadProgress: number;
  error: string | null;
}

// Quick Access Types
export interface QuickAccessTeam {
  id: number;
  name: string;
  is_system: boolean; // True if from system recommendations
  recommended_mode?: 'chat' | 'code' | 'both';
  agent_type?: string;
  icon?: string; // Icon ID from preset icon library
}

export interface QuickAccessResponse {
  system_version: number;
  user_version: number | null;
  show_system_recommended: boolean; // True if user_version < system_version
  teams: QuickAccessTeam[];
}

// Welcome Config Types (Slogan & Tips)
export interface ChatSloganItem {
  id: number;
  zh: string;
  en: string;
  mode?: 'chat' | 'code' | 'both';
}

export interface ChatTipItem {
  id: number;
  zh: string;
  en: string;
  mode?: 'chat' | 'code' | 'both';
}

export interface WelcomeConfigResponse {
  slogans: ChatSloganItem[];
  tips: ChatTipItem[];
}

export interface SystemConfigResponse {
  version: number;
  teams: number[];
}

export interface SystemConfigUpdate {
  teams: number[];
}
