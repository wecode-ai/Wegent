import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  Bot,
  Calendar,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleUserRound,
  Copy,
  File,
  FileText,
  Flag,
  Folder,
  History,
  Link2,
  ListTodo,
  Maximize2,
  Minimize2,
  Package,
  Plus,
  Tag,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import {
  IssueDetailAssigneeSelect,
  IssueDetailAttachments,
  IssueDetailPrioritySelect,
  IssueDetailStatusSelect,
  IssueWorkflowPlanSection,
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
  persistIssueDetailDraft,
  sharedIssueDetailWorkflowPlanView,
  useIssueDetailDraft,
  type DueDateSourceContext,
  type IssueDetailAttachment,
  type IssueAssigneeTarget,
  type SharedIssueDetailAgent,
  type SharedIssueDetailCollaborator,
  type SharedIssueDetailCreateInput,
  type SharedIssueDetailDelivery,
  type SharedIssueDetailDeliveryDetail,
  type SharedIssueDetailPort,
  type SharedIssueDetailTaskBinding,
  type SharedIssueDetailWorkflowPlan,
} from "./issue-detail";
import { IssueWorkflowDag, type SharedWorkflowNode } from "./issue-detail";
import "./issue-detail/issue-detail.css";
import type {
  CollaborationAttachment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationStatus,
} from "./types";
import { markdownAttachmentRows } from "./issue-detail/attachmentMarkdown";
import { TagEditor } from "./issue-detail/TagEditor";
import "./issue-detail/task-detail-layout.css";
import { localizeStandardStatuses } from "./i18n";

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface SharedIssueWorkflow {
  advancement_policy?: "manual" | "ai";
  orchestration_status?: SharedIssueDetailWorkflowPlan["status"];
  nodes?: unknown[];
}

export interface SharedEditorIssue extends CollaborationIssue {
  assignment_history?: Array<{
    by_user_id: number;
    to_type: "user" | "agent" | "team" | null;
    to_id: string | null;
    to_name?: string | null;
    action: "assign" | "reassign" | "unassign";
    at: string;
  }>;
  status_history?: Array<{
    from_status: string;
    from_status_name?: string | null;
    to_status: string;
    to_status_name?: string | null;
    trigger: string;
    by_user_id: number | null;
    at: string;
  }>;
  automation?: { trigger?: string } | null;
  workflow?: SharedIssueWorkflow | null;
  execution_error?: string | null;
  source_record_id?: string | null;
  source_cells?: Record<string, unknown>;
}

export interface SharedEditorProject extends CollaborationProject {
  board_config?: {
    group_by: "status" | "priority" | "assignee" | "tag";
    processing_start_status_id: string | null;
    statuses: CollaborationStatus[];
  };
}

export interface SharedEditorTeam {
  id: number;
  name: string;
  displayName?: string | null;
  is_active?: boolean;
}

export interface SharedIssueDetailExtensionContext {
  item: SharedEditorIssue;
  project: SharedEditorProject;
  editable: boolean;
  tasks: SharedIssueDetailTaskBinding[];
  deliveries: SharedIssueDetailDelivery[];
  selectedTaskId?: string | null;
  workflowManagerRunId?: string;
  onTaskBindingsChange(): Promise<void>;
  onItemChange(item: SharedEditorIssue): void;
  onOpenManagerExecutionChange(action: (() => void) | null): void;
  onWorkflowManagerFinished(): void;
}

export interface SharedIssueDetailExtensions {
  normalizeDescription?(value: string): string;
  dueDateInputType?: "date" | "datetime-local";
  dueDateFromSource?(value: string | null): string;
  dueDateToSource?(value: string, context: DueDateSourceContext): string;
  isExecutionActive?(item: SharedEditorIssue): boolean;
  reconcileWorkflow?(
    workflow: SharedIssueWorkflow,
    tasks: SharedIssueDetailTaskBinding[],
  ): SharedIssueWorkflow;
  openAttachment?(attachmentId: string, filename: string): Promise<void>;
  renderDescriptionEditor?(context: {
    value: string;
    editable: boolean;
    onChange(value: string): void;
    onPasteFiles(files: File[]): void;
    readAttachment(attachmentId: string): Promise<Blob>;
  }): ReactNode;
  renderActivity?(context: SharedIssueDetailExtensionContext): ReactNode;
  renderAITableFields?(context: {
    item: SharedEditorIssue;
    project: SharedEditorProject;
  }): ReactNode;
  renderAssignmentHistory?(context: {
    anchor: HTMLElement | null;
    entries: NonNullable<SharedEditorIssue["assignment_history"]>;
    members: CollaborationMember[];
    onClose(): void;
  }): ReactNode;
  renderStatusHistory?(context: {
    anchor: HTMLElement | null;
    entries: NonNullable<SharedEditorIssue["status_history"]>;
    members: CollaborationMember[];
    onClose(): void;
  }): ReactNode;
  renderCreateOptions?(context: { saving: boolean }): ReactNode;
}

type TodoEditorPort = SharedIssueDetailPort;
type CloudLoopItem = SharedEditorIssue;
type CloudLoopItemAttachment = CollaborationAttachment;
type CloudLoopItemCollaborator = SharedIssueDetailCollaborator;
type CloudProject = SharedEditorProject;
type CloudProjectMember = CollaborationMember;
type Delivery = SharedIssueDetailDelivery;
type DeliveryDetail = SharedIssueDetailDeliveryDetail;
type IssueWorkflowInstance = SharedIssueWorkflow;
type LoopItemTaskBinding = SharedIssueDetailTaskBinding;
type WorkflowPlan = SharedIssueDetailWorkflowPlan;
type TodoEditorAgent = SharedIssueDetailAgent;

type WorkflowPlanAction =
  | "approveWorkflowPlan"
  | "approveWorkflowReview"
  | "pauseWorkflowPlan"
  | "resumeWorkflowPlan"
  | "replanWorkflowPlan";

type WorkflowPlanMethod = (itemId: string) => Promise<WorkflowPlan>;

const columns = [
  { status: "inbox", label: "收集箱" },
  { status: "pending", label: "待开始" },
  { status: "in_progress", label: "进行中" },
  { status: "in_review", label: "待确认" },
  { status: "completed", label: "已完成" },
];
const columnDotClasses: Record<string, string> = {
  inbox: "bg-zinc-400",
  pending: "bg-indigo-500",
  in_progress: "bg-amber-500",
  in_review: "bg-violet-500",
  completed: "bg-emerald-500",
};
const priorityBadgeClasses: Record<CollaborationPriority, string> = {
  none: "bg-muted text-text-secondary",
  low: "bg-muted text-text-secondary",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  urgent: "bg-red-500/10 text-red-600 dark:text-red-400",
};
const memberAvatarClasses = [
  "bg-gradient-to-br from-indigo-400 to-indigo-500",
  "bg-gradient-to-br from-emerald-400 to-emerald-500",
  "bg-gradient-to-br from-amber-400 to-amber-500",
];

function memberNameById(
  members: CollaborationMember[],
  userId: number | null,
): string | null {
  return members.find((member) => member.user_id === userId)?.user_name ?? null;
}

function workflowPlanMethod(
  port: TodoEditorPort,
  action: WorkflowPlanAction,
): WorkflowPlanMethod | null {
  return (
    {
      approveWorkflowPlan: port.workflowPlans.approve,
      approveWorkflowReview: port.workflowPlans.approveReview,
      pauseWorkflowPlan: port.workflowPlans.pause,
      resumeWorkflowPlan: port.workflowPlans.resume,
      replanWorkflowPlan: port.workflowPlans.replan,
    }[action] ?? null
  );
}

type AttachmentRow = Pick<
  CloudLoopItemAttachment,
  "id" | "display_name" | "size_bytes"
>;

type TodoDraft = {
  title: string;
  markdown: string;
  priority: CloudLoopItem["priority"];
  parentId: string;
  dueDate: string;
  tags: string[];
};

const todoDraftPriorities: CloudLoopItem["priority"][] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

// Drafts are keyed per project and per lane so every swimlane keeps its own
// draft. File objects cannot be serialized, so staged attachments live in
// module memory under the same key.
const draftAttachmentStore = new Map<string, File[]>();

function todoDraftKey(
  projectId: CloudProject["id"],
  status: CloudLoopItem["status"],
): string {
  return `wework-todo-draft:${projectId}:${status}`;
}

function readTodoDraft(key: string): TodoDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TodoDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : "",
      priority: todoDraftPriorities.includes(
        parsed.priority as CloudLoopItem["priority"],
      )
        ? (parsed.priority as CloudLoopItem["priority"])
        : "none",
      parentId: typeof parsed.parentId === "string" ? parsed.parentId : "",
      dueDate: typeof parsed.dueDate === "string" ? parsed.dueDate : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function descendantIds(items: CloudLoopItem[], itemId: string): Set<string> {
  const result = new Set<string>();
  const pending = [itemId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const item of items) {
      if (item.parent_id === current && !result.has(item.id)) {
        result.add(item.id);
        pending.push(item.id);
      }
    }
  }
  return result;
}

function appendAttachmentMarkdown(
  description: string,
  markdown: string,
): string {
  if (!markdown) return description;
  return `${description.trimEnd()}\n\n${markdown}`.trim();
}

function todoDueDateFromSource(dueAt: string | null): string {
  return dueAt?.slice(0, 10) ?? "";
}

const propChipClass =
  "task-detail-pill relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 py-1.5 text-xs text-text-primary transition hover:bg-muted";
const overlayControlClass =
  "absolute inset-0 h-full w-full cursor-pointer opacity-0";
const avatarPalette = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-orange-500",
  "bg-zinc-600",
  "bg-rose-500",
];

function sourceCellText(
  cells: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!cells) return null;
  for (const [key, value] of Object.entries(cells)) {
    const normalized = key.toLowerCase();
    if (!keys.some((candidate) => normalized.includes(candidate))) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      const text = value
        .map((entry) =>
          typeof entry === "string" || typeof entry === "number"
            ? String(entry)
            : "",
        )
        .filter(Boolean)
        .join("、");
      if (text) return text;
    }
  }
  return null;
}

function tagByPattern(tags: string[], pattern: RegExp): string | null {
  return tags.find((tag) => pattern.test(tag)) ?? null;
}

function AvatarMark({
  name,
  index = 0,
  size = "md",
}: {
  name: string;
  index?: number;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-background",
        size === "md" ? "h-6 w-6 text-xs" : "h-5 w-5 text-xs",
        avatarPalette[index % avatarPalette.length],
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function RailProp({
  label,
  children,
  control,
  testId,
  clickable = Boolean(control),
  valueClassName,
}: {
  label: string;
  children: ReactNode;
  control?: ReactNode;
  testId?: string;
  clickable?: boolean;
  valueClassName?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="task-detail-rail-prop relative flex min-w-0 items-center gap-2"
    >
      <span className="task-detail-rail-key w-[64px] shrink-0 text-xs font-medium leading-5 text-text-muted">
        {label}
      </span>
      <span
        className={cn(
          "task-detail-rail-value flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium leading-5 text-text-primary",
          clickable && "group relative",
          valueClassName,
        )}
      >
        {clickable ? (
          <span className="pointer-events-none absolute -inset-x-1.5 -inset-y-[3px] rounded-md transition group-hover:bg-muted" />
        ) : null}
        <span className="task-detail-rail-value-content relative flex min-w-0 items-center gap-1.5 truncate">
          {children}
        </span>
        {control}
      </span>
    </span>
  );
}

function TodoAttachmentSection({
  attachments,
  busy,
  error,
  editable,
  compactRail = false,
  downloadingId,
  onAdd,
  onOpen,
  onDownload,
  onRemove,
  translate,
}: {
  attachments: AttachmentRow[];
  busy: boolean;
  error: string | null;
  editable: boolean;
  compactRail?: boolean;
  downloadingId?: string | null;
  onAdd: (files: FileList | null) => Promise<void>;
  onOpen?: (attachment: AttachmentRow) => Promise<void>;
  onDownload?: (attachment: AttachmentRow) => Promise<void>;
  onRemove: (attachment: AttachmentRow) => Promise<void>;
  translate: (
    key: string,
    fallback?: string,
    options?: Record<string, string | number>,
  ) => string;
}) {
  const sharedAttachments: IssueDetailAttachment[] = attachments.map(
    (attachment) => ({
      id: attachment.id,
      displayName: attachment.display_name,
      sizeBytes: attachment.size_bytes,
    }),
  );
  const byId = new Map(
    attachments.map((attachment) => [attachment.id, attachment]),
  );
  return (
    <IssueDetailAttachments
      attachments={sharedAttachments}
      busy={busy}
      error={error}
      editable={editable}
      compact={compactRail}
      downloadingId={downloadingId}
      labels={{
        title: translate("todo.attachment", "附件"),
        upload: translate("todo.upload", "＋ 上传"),
        uploading: translate("todo.uploading", "上传中…"),
        empty: translate("todo.no_attachments", "暂无附件"),
        dropzone: translate(
          "todo.attachment_dropzone",
          "点击上传或拖拽文件到这里",
        ),
        downloading: translate("todo.file_downloading", "下载中…"),
        expand: (count) =>
          translate("todo.view_all_count", "查看全部 {{count}} 个", {
            count,
          }),
        collapse: translate("todo.collapse", "收起"),
        download: (name) =>
          translate("todo.download_name", "下载 {{name}}", { name }),
        remove: (name) =>
          translate("todo.remove_name", "删除 {{name}}", { name }),
      }}
      testIdPrefix="cloud-todo-attachment"
      icons={{
        file: <File className="icon" />,
        remove: <Trash2 className="icon" />,
      }}
      onAdd={onAdd}
      onOpen={
        onOpen
          ? async (attachment) => {
              const original = byId.get(attachment.id);
              if (original) await onOpen(original);
            }
          : undefined
      }
      onDownload={
        onDownload
          ? async (attachment) => {
              const original = byId.get(attachment.id);
              if (original) await onDownload(original);
            }
          : undefined
      }
      onRemove={async (attachment) => {
        const original = byId.get(attachment.id);
        if (original) await onRemove(original);
      }}
    />
  );
}

export interface TodoEditorCreateProps {
  mode: "create";
  project: CloudProject;
  initialParent: CloudLoopItem | null;
  initialStatus: CloudLoopItem["status"];
  initialTitle?: string;
  onCreated: (item: CloudLoopItem) => void | Promise<void>;
  onCreateError?: (
    error: unknown,
    retry: (
      overrides?: Partial<SharedIssueDetailCreateInput>,
    ) => Promise<CloudLoopItem>,
  ) => boolean | Promise<boolean>;
}

export interface TodoEditorEditProps {
  mode: "edit";
  item: CloudLoopItem;
  project?: CloudProject;
  editable: boolean;
  onUpdated: (item: CloudLoopItem) => void;
  onAddChild?: () => void;
}

export type TodoEditorProps = {
  port: TodoEditorPort;
  extensions?: SharedIssueDetailExtensions;
  translate?: (
    key: string,
    fallback?: string,
    options?: Record<string, string | number>,
  ) => string;
  loadTeams?: () => Promise<SharedEditorTeam[]>;
  currentUserId?: string | number;
  allItems: CloudLoopItem[];
  onClose: () => void;
  presentation?: "modal" | "workspace-panel";
  workspacePanelFill?: boolean;
  showPanelControls?: boolean;
  showChildren?: boolean;
  showCurrentTaskOnly?: boolean;
  taskRefreshKey?: string | number;
  headerActions?: ReactNode;
  selectedTaskId?: string | null;
  onCreateTask?: (workflowNodeId?: string) => void;
  onOpenTaskConversation?: (task: SharedIssueDetailTaskBinding) => void;
  onOpenChildTask?: (task: CloudLoopItem) => void;
  onWorkflowPlanChanged?: () => void | Promise<void>;
} & (TodoEditorCreateProps | TodoEditorEditProps);

// Single panel for creating, viewing, and editing a todo. Create mode keeps a
// local draft and stages attachments until the item exists; edit mode loads the
// sections that require an item id (children, collaborators, executions,
// deliveries) and saves through a versioned update.
export function TodoEditor(props: TodoEditorProps) {
  const { allItems, onClose } = props;
  const editorPort = props.port;
  const extensions = props.extensions;
  const t = props.translate ?? ((_key: string, fallback = _key) => fallback);
  const workflowTranslate = useCallback(
    (
      key: string,
      fallbackOrOptions?: string | Record<string, string | number>,
      options?: Record<string, string | number>,
    ) =>
      typeof fallbackOrOptions === "string"
        ? t(key, fallbackOrOptions, options)
        : t(key, undefined, fallbackOrOptions),
    [t],
  );
  const showChildren = props.showChildren !== false;
  const createProps = props.mode === "create" ? props : null;
  const editProps = props.mode === "edit" ? props : null;
  const isCreate = createProps !== null;
  const editable = isCreate || editProps?.editable === true;
  const workspacePanel = props.presentation === "workspace-panel";
  const showPanelControls = props.showPanelControls !== false;
  const item = editProps?.item ?? null;
  const isAITableEdit =
    item !== null && editProps?.project?.task_provider === "dingtalk_aitable";
  const project = createProps?.project ?? editProps?.project;
  const statusOptions = project?.board_config?.statuses
    ? localizeStandardStatuses(project.board_config.statuses, t)
    : columns.map((column) => ({
        id: column.status,
        name: t(`todo.status_${column.status}`, column.label),
        color: "gray" as const,
      }));

  const draftKey = createProps
    ? todoDraftKey(createProps.project.id, createProps.initialStatus)
    : null;
  const [draft] = useState(() => (draftKey ? readTodoDraft(draftKey) : null));

  const {
    draft: issueDraft,
    setField: setIssueDraftField,
    dirty,
  } = useIssueDetailDraft<IssueWorkflowInstance>({
    source: item,
    initial: {
      title: createProps?.initialTitle ?? draft?.title ?? "",
      description: draft?.markdown ?? "",
      status: createProps?.initialStatus ?? "inbox",
      priority: draft?.priority ?? "none",
      parentId: draft?.parentId ?? createProps?.initialParent?.id ?? "",
      dueDate: draft?.dueDate ?? "",
      tags: draft?.tags ?? [],
    },
    normalizeDescription: extensions?.normalizeDescription,
    dueDateFromSource: extensions?.dueDateFromSource ?? todoDueDateFromSource,
  });
  const {
    title,
    description,
    status,
    priority,
    parentId,
    dueDate,
    assigneeTarget,
    tags,
    workflow: workflowDraft,
  } = issueDraft;
  const setTitle = (value: SetStateAction<string>) =>
    setIssueDraftField("title", value);
  const setDescription = (value: SetStateAction<string>) =>
    setIssueDraftField("description", value);
  const setStatus = (value: SetStateAction<CloudLoopItem["status"]>) =>
    setIssueDraftField("status", value);
  const setPriority = (value: SetStateAction<CloudLoopItem["priority"]>) =>
    setIssueDraftField("priority", value);
  const setParentId = useCallback(
    (value: SetStateAction<string>) => setIssueDraftField("parentId", value),
    [setIssueDraftField],
  );
  const setDueDate = (value: SetStateAction<string>) =>
    setIssueDraftField("dueDate", value);
  const setAssigneeTarget = (value: SetStateAction<IssueAssigneeTarget>) =>
    setIssueDraftField("assigneeTarget", value);
  const setTags = (value: SetStateAction<string[]>) =>
    setIssueDraftField("tags", value);
  const [notifyAssignee, setNotifyAssignee] = useState(true);
  const [notificationChoiceOpen, setNotificationChoiceOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  // A create draft or initial parent can reference a task that was archived
  // since; a deleted parent is not in the live item list, so fall back to a
  // top-level task instead of sending a parent id the backend rejects.
  useEffect(() => {
    if (item || !parentId || allItems.length === 0) return;
    if (allItems.some((candidate) => candidate.id === parentId)) return;
    setParentId("");
  }, [allItems, item, parentId, setParentId]);
  // Tag autocomplete candidates: the project registry plus tags already used
  // by any item in the project.
  const tagSuggestions = Array.from(
    new Set([
      ...(createProps?.project.tags ?? editProps?.project?.tags ?? []),
      ...allItems.flatMap((candidate) => candidate.tags ?? []),
    ]),
  ).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const [pendingFiles, setPendingFiles] = useState<File[]>(() =>
    draftKey ? (draftAttachmentStore.get(draftKey) ?? []) : [],
  );

  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [selectedDelivery, setSelectedDelivery] =
    useState<DeliveryDetail | null>(null);
  const [tasks, setTasks] = useState<LoopItemTaskBinding[]>([]);
  const [attachments, setAttachments] = useState<CloudLoopItemAttachment[]>([]);
  const [collaborators, setCollaborators] = useState<
    CloudLoopItemCollaborator[]
  >([]);
  const [projectMembers, setProjectMembers] = useState<CloudProjectMember[]>(
    [],
  );
  const [projectAgents, setProjectAgents] = useState<TodoEditorAgent[]>([]);
  const [wegentTeams, setWegentTeams] = useState<SharedEditorTeam[]>([]);
  const [workflowPlanState, setWorkflowPlanState] = useState<{
    itemId: string;
    plan: WorkflowPlan | null;
  } | null>(null);
  const workflowPlanRequestIdRef = useRef(0);
  const [workflowPlanBusy, setWorkflowPlanBusy] = useState(false);
  const [openWorkflowManagerExecution, setOpenWorkflowManagerExecution] =
    useState<(() => void) | null>(null);
  const [workflowPlanErrorState, setWorkflowPlanErrorState] = useState<{
    itemId: string;
    error: string | null;
  } | null>(null);
  const [addingCollaborator, setAddingCollaborator] = useState(false);
  const [selectedCollaboratorId, setSelectedCollaboratorId] = useState<
    number | null
  >(null);
  const [collaboratorBusy, setCollaboratorBusy] = useState(false);
  const [collaboratorError, setCollaboratorError] = useState<string | null>(
    null,
  );
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<
    string | null
  >(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionOverflowing, setDescriptionOverflowing] = useState(false);
  const [expandedRailSections, setExpandedRailSections] = useState<
    Record<string, boolean>
  >({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [assignmentChainOpen, setAssignmentChainOpen] = useState(false);
  const assignmentChainTriggerRef = useRef<HTMLButtonElement>(null);
  const [statusHistoryOpen, setStatusHistoryOpen] = useState(false);
  const statusHistoryTriggerRef = useRef<HTMLButtonElement>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const descriptionCollapseRef = useRef<HTMLDivElement>(null);

  const editItemId = item?.id ?? null;
  const editProjectId = item?.cloud_project_id ?? null;
  const createProjectId = createProps?.project.id ?? null;
  const workflowPlan =
    workflowPlanState?.itemId === editItemId ? workflowPlanState.plan : null;
  const workflowPlanError =
    workflowPlanErrorState?.itemId === editItemId
      ? workflowPlanErrorState.error
      : null;
  const loadedEditItemIdRef = useRef(editItemId);
  const visibleAttachments = useMemo(() => {
    const merged = new Map<string, AttachmentRow>();
    markdownAttachmentRows(description).forEach((attachment) =>
      merged.set(attachment.id, attachment),
    );
    attachments.forEach((attachment) => merged.set(attachment.id, attachment));
    return Array.from(merged.values());
  }, [attachments, description]);
  const displayedWorkflow = useMemo(
    () =>
      workflowDraft
        ? (extensions?.reconcileWorkflow?.(workflowDraft, tasks) ??
          workflowDraft)
        : null,
    [extensions, workflowDraft, tasks],
  );
  const refreshTaskBindings = useCallback(async () => {
    if (editItemId == null) return;
    setTasks(await editorPort.taskBindings.list(editItemId, editProjectId));
  }, [editItemId, editProjectId, editorPort]);

  useEffect(() => {
    const node = detailScrollRef.current;
    if (!node) return;
    node.scrollTop = 0;
  }, [editItemId, isCreate]);

  useEffect(() => {
    if (!workspacePanel || descriptionExpanded) return;
    const container = descriptionCollapseRef.current;
    if (!container) return;

    let frameId: number | null = null;
    const updateOverflow = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const editor = container.querySelector<HTMLElement>(".bn-editor");
        const editorBottom = editor?.getBoundingClientRect().bottom ?? 0;
        const overflowing = Array.from(
          editor?.querySelectorAll<HTMLElement>(".bn-block-outer") ?? [],
        ).some(
          (block) => block.getBoundingClientRect().bottom > editorBottom + 1,
        );
        setDescriptionOverflowing((current) =>
          current === overflowing ? current : overflowing,
        );
      });
    };

    updateOverflow();
    const mutationObserver = new MutationObserver(updateOverflow);
    mutationObserver.observe(container, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateOverflow);
    resizeObserver?.observe(container);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [descriptionExpanded, editItemId, workspacePanel]);

  useLayoutEffect(() => {
    if (loadedEditItemIdRef.current === editItemId) return;
    loadedEditItemIdRef.current = editItemId;
    setDeliveries([]);
    setSelectedDelivery(null);
    setTasks([]);
    setAttachments([]);
    setCollaborators([]);
    setDownloadingAttachmentId(null);
    setAttachmentError(null);
  }, [editItemId]);

  // Edit mode loads everything tied to the item id.
  useEffect(() => {
    if (editItemId == null || editProjectId == null) return;
    let active = true;
    const applyResult = <T,>(
      request: Promise<T>,
      apply: (value: T) => void,
    ) => {
      void request.then(
        (value) => {
          if (active) apply(value);
        },
        () => undefined,
      );
    };

    applyResult(editorPort.deliveries.list(editItemId), setDeliveries);
    applyResult(
      editorPort.taskBindings.list(editItemId, editProjectId),
      setTasks,
    );
    applyResult(editorPort.attachments.list(editItemId), setAttachments);
    applyResult(editorPort.collaborators.list(editItemId), setCollaborators);
    applyResult(editorPort.members.list(editProjectId), setProjectMembers);
    applyResult(editorPort.agents.list(String(editProjectId)), (agents) =>
      setProjectAgents(agents.filter((agent) => agent.status !== "inactive")),
    );
    applyResult(props.loadTeams?.() ?? Promise.resolve([]), (teams) =>
      setWegentTeams(teams.filter((team) => team.is_active !== false)),
    );

    return () => {
      active = false;
    };
  }, [
    editorPort,
    editItemId,
    editProjectId,
    props.loadTeams,
    props.taskRefreshKey,
  ]);

  const refreshWorkflowPlan = useCallback(() => {
    if (editItemId == null || item?.workflow?.advancement_policy !== "ai")
      return;
    const getWorkflowPlan = editorPort.workflowPlans.get;
    if (!getWorkflowPlan) return;
    const requestId = ++workflowPlanRequestIdRef.current;
    void getWorkflowPlan(editItemId)
      .then((plan) => {
        if (requestId !== workflowPlanRequestIdRef.current) return;
        setWorkflowPlanState({ itemId: editItemId, plan });
        setWorkflowPlanErrorState({ itemId: editItemId, error: null });
      })
      .catch((error) => {
        if (requestId !== workflowPlanRequestIdRef.current) return;
        setWorkflowPlanErrorState({
          itemId: editItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [editItemId, editorPort, item?.workflow?.advancement_policy]);

  useEffect(() => {
    refreshWorkflowPlan();
  }, [props.taskRefreshKey, refreshWorkflowPlan]);

  // Assignee sources are independent: one unavailable directory must not hide
  // otherwise valid members, robots, or Wegent Teams.
  useEffect(() => {
    if (createProjectId == null) return;
    void Promise.allSettled([
      editorPort.members.list(createProjectId),
      editorPort.agents.list(String(createProjectId)),
      props.loadTeams?.() ?? Promise.resolve([]),
    ]).then(([memberResult, agentResult, teamResult]) => {
      if (memberResult.status === "fulfilled")
        setProjectMembers(memberResult.value);
      if (agentResult.status === "fulfilled") {
        setProjectAgents(
          agentResult.value.filter((agent) => agent.status !== "inactive"),
        );
      }
      if (teamResult.status === "fulfilled") {
        setWegentTeams(
          teamResult.value.filter((team) => team.is_active !== false),
        );
      }
    });
  }, [createProjectId, editorPort, props.loadTeams]);

  // Persist the text draft on every edit; a fully cleared form removes it.
  useEffect(() => {
    if (!draftKey) return;
    if (
      !title &&
      !description &&
      priority === "none" &&
      !parentId &&
      !dueDate &&
      !tags.length
    ) {
      localStorage.removeItem(draftKey);
      return;
    }
    const snapshot: TodoDraft = {
      title,
      markdown: description,
      priority,
      parentId,
      dueDate,
      tags,
    };
    localStorage.setItem(draftKey, JSON.stringify(snapshot));
  }, [draftKey, title, description, priority, parentId, dueDate, tags]);

  useEffect(() => {
    if (!draftKey) return;
    if (pendingFiles.length > 0)
      draftAttachmentStore.set(draftKey, pendingFiles);
    else draftAttachmentStore.delete(draftKey);
  }, [draftKey, pendingFiles]);

  const availableCollaborators = projectMembers.filter(
    (member) =>
      !collaborators.some(
        (collaborator) => collaborator.user_id === member.user_id,
      ),
  );
  const excludedParentIds = item
    ? descendantIds(allItems, item.id)
    : new Set<string>();
  if (item) excludedParentIds.add(item.id);
  const parentOptions = allItems.filter(
    (candidate) => !excludedParentIds.has(candidate.id),
  );
  const childItems = item
    ? allItems.filter((candidate) => candidate.parent_id === item.id)
    : [];
  const itemHasActiveTask = item
    ? (extensions?.isExecutionActive?.(item) ?? false)
    : false;
  const displayedTasks = props.showCurrentTaskOnly
    ? itemHasActiveTask
      ? tasks.slice(0, 1)
      : []
    : tasks;
  const executionChildItems = showChildren ? [] : childItems;
  const executionTaskCount = executionChildItems.length + displayedTasks.length;
  const workflowPlanStatus =
    workflowPlan?.status ?? item?.workflow?.orchestration_status ?? "idle";
  const registerWorkflowManagerExecution = useCallback(
    (action: (() => void) | null) => {
      setOpenWorkflowManagerExecution(() => action);
    },
    [],
  );
  const workflowDirty =
    JSON.stringify(workflowDraft) !== JSON.stringify(item?.workflow ?? null);
  const hasDraftContent = Boolean(
    title ||
    description ||
    priority !== "none" ||
    dueDate ||
    tags.length > 0 ||
    pendingFiles.length > 0,
  );
  const pendingAttachmentRows: AttachmentRow[] = pendingFiles.map(
    (file, index) => ({
      id: `pending-${index}`,
      display_name: file.name,
      size_bytes: file.size,
    }),
  );
  const childRailExpanded = Boolean(expandedRailSections.children);
  const executionRailExpanded = Boolean(expandedRailSections.executions);
  const deliveryRailExpanded = Boolean(expandedRailSections.deliveries);
  const visibleRailChildren = childRailExpanded
    ? childItems
    : childItems.slice(0, 2);
  const visibleRailTasks = executionRailExpanded ? tasks : tasks.slice(0, 2);
  const visibleRailDeliveries = deliveryRailExpanded
    ? deliveries
    : deliveries.slice(0, 2);
  const toggleRailSection = (
    section: "children" | "executions" | "deliveries",
  ) => {
    setExpandedRailSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };
  const statusLabel =
    statusOptions.find((option) => option.id === status)?.name ??
    t("todo.not_set", "未设置");
  const parentItem = allItems.find((candidate) => candidate.id === parentId);
  const assignee = projectMembers.find(
    (member) => assigneeTarget === `user:${member.user_id}`,
  );
  const assigneeAgent = projectAgents.find(
    (agent) => assigneeTarget === `agent:${agent.id}`,
  );
  const assigneeTeam = wegentTeams.find(
    (team) => assigneeTarget === `team:${team.id}`,
  );
  const canAssign = project
    ? project.access_role === "Owner" || project.access_role === "Maintainer"
    : false;
  const creator =
    item?.created_by_user_name ||
    (item && item.created_by_user_id === editProps?.project?.current_user_id
      ? editProps?.project?.current_user_name
      : item
        ? memberNameById(projectMembers, item.created_by_user_id)
        : null);

  async function mutateWorkflowPlan(action: WorkflowPlanAction) {
    if (!editable || !item || workflowPlanBusy) return;
    const method = workflowPlanMethod(editorPort, action);
    if (!method) return;
    workflowPlanRequestIdRef.current += 1;
    setWorkflowPlanBusy(true);
    setWorkflowPlanErrorState({ itemId: item.id, error: null });
    try {
      const plan = await method(item.id);
      setWorkflowPlanState({ itemId: item.id, plan });
      await props.onWorkflowPlanChanged?.();
      editProps?.onUpdated(await editorPort.issues.get(item.id));
    } catch (error) {
      setWorkflowPlanErrorState({
        itemId: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setWorkflowPlanBusy(false);
    }
  }

  async function submitCreate() {
    if (props.mode !== "create" || !title.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    const createInput: SharedIssueDetailCreateInput = {
      title: title.trim(),
      description,
      priority,
      status,
      tags,
    };
    const dueAt = dueDate
      ? (extensions?.dueDateToSource?.(dueDate, {
          sourceValue: null,
          sourceInputValue: "",
        }) ?? dueDate)
      : "";
    const creatorName =
      props.project.current_user_name ||
      memberNameById(projectMembers, props.project.current_user_id ?? null);
    Object.assign(createInput, {
      ...(parentId ? { parent_id: parentId } : {}),
      ...(dueAt ? { due_at: dueAt } : {}),
      ...(creatorName ? { creator_name: creatorName } : {}),
    });
    const create = async (
      overrides: Partial<SharedIssueDetailCreateInput> = {},
    ): Promise<CloudLoopItem> => {
      let created = await editorPort.issues.create(props.project.id, {
        ...createInput,
        ...overrides,
      });
      // The create API intentionally does not assign. Assigning after creation
      // records the assignment chain and applies notification policy once.
      if (assigneeTarget) {
        created = await editorPort.issues.assign(props.project.id, created.id, {
          version: created.version,
          assigneeType: assigneeTarget.split(":", 1)[0] as
            | "user"
            | "agent"
            | "team",
          assigneeId: assigneeTarget.slice(assigneeTarget.indexOf(":") + 1),
          ...(assigneeTarget.startsWith("user:") ? { notifyAssignee } : {}),
        });
      }
      const uploaded = await uploadAttachments(created.id, pendingFiles);
      if (uploaded.markdown) {
        created = await editorPort.issues.update(created.id, {
          version: created.version,
          description: appendAttachmentMarkdown(description, uploaded.markdown),
        });
      }
      if (draftKey) {
        localStorage.removeItem(draftKey);
        draftAttachmentStore.delete(draftKey);
      }
      await props.onCreated(created);
      return created;
    };
    try {
      await create();
    } catch (cause) {
      const handled = await props.onCreateError?.(
        cause,
        async (overrides = {}) => {
          setSaving(true);
          setSaveError(null);
          try {
            return await create(overrides);
          } finally {
            setSaving(false);
          }
        },
      );
      if (handled) return;
      setSaveError(
        cause instanceof Error
          ? cause.message
          : t("todo.create_issue_failed", "创建任务失败"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveDetails() {
    if (props.mode !== "edit" || !editable || !dirty || !title.trim() || saving)
      return;
    const current = props.item;
    setSaving(true);
    setSaveError(null);
    try {
      const sourceDueDate = (
        extensions?.dueDateFromSource ?? todoDueDateFromSource
      )(current.due_at);
      const dueAt = dueDate
        ? (extensions?.dueDateToSource?.(dueDate, {
            sourceValue: current.due_at,
            sourceInputValue: sourceDueDate,
          }) ?? dueDate)
        : null;
      const updated = await persistIssueDetailDraft<CloudLoopItem>(
        current,
        issueDraft,
        notifyAssignee,
        {
          getAssigneeTarget: issueAssigneeTarget,
          update: (source, values) =>
            editorPort.issues.update(source.id, {
              version: source.version,
              title: values.title.trim(),
              description: values.description,
              status: values.status,
              priority: values.priority,
              parent_id: values.parentId || null,
              due_at: dueAt,
              tags: values.tags,
              ...(workflowDirty
                ? {
                    workflow: values.workflow as unknown as Record<
                      string,
                      unknown
                    > | null,
                  }
                : {}),
            }),
          clearAssignment: (source) =>
            editorPort.issues.update(source.id, {
              version: source.version,
              assignee_user_id: null,
              assignee_agent_id: null,
              assignee_team_id: null,
            }),
          assign: (source, target, shouldNotify) => {
            if (project) {
              return editorPort.issues.assign(project.id, source.id, {
                version: source.version,
                assigneeType: target.slice(0, target.indexOf(":")) as
                  | "user"
                  | "agent"
                  | "team",
                assigneeId: target.slice(target.indexOf(":") + 1),
                ...(target.startsWith("user:")
                  ? { notifyAssignee: shouldNotify }
                  : {}),
              });
            }
            const assignment = parseIssueAssigneeTarget(target);
            return editorPort.issues.update(source.id, {
              version: source.version,
              assignee_user_id: assignment.assigneeUserId,
              assignee_agent_id: assignment.assigneeAgentId,
              assignee_team_id: assignment.assigneeTeamId,
            });
          },
        },
      );
      props.onUpdated(updated);
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : t("todo.save_issue_failed", "保存任务失败"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function addCollaborator() {
    if (!editable || !editItemId || !selectedCollaboratorId || collaboratorBusy)
      return;
    setCollaboratorBusy(true);
    setCollaboratorError(null);
    try {
      const collaborator = await editorPort.collaborators.add(
        editItemId,
        selectedCollaboratorId,
      );
      setCollaborators((current) => [...current, collaborator]);
      setSelectedCollaboratorId(null);
      setAddingCollaborator(false);
    } catch (cause) {
      setCollaboratorError(
        cause instanceof Error
          ? cause.message
          : t("todo.add_collaborator_failed", "添加参与者失败"),
      );
    } finally {
      setCollaboratorBusy(false);
    }
  }

  async function removeCollaborator(collaborator: CloudLoopItemCollaborator) {
    if (!editable || !editItemId || collaboratorBusy) return;
    setCollaboratorBusy(true);
    setCollaboratorError(null);
    try {
      await editorPort.collaborators.remove(editItemId, collaborator.user_id);
      setCollaborators((current) =>
        current.filter((entry) => entry.id !== collaborator.id),
      );
    } catch (cause) {
      setCollaboratorError(
        cause instanceof Error
          ? cause.message
          : t("todo.remove_collaborator_failed", "移除参与者失败"),
      );
    } finally {
      setCollaboratorBusy(false);
    }
  }

  async function stageFiles(files: FileList | null) {
    if (!files?.length) return;
    setPendingFiles((current) => [...current, ...Array.from(files)]);
  }

  async function removePendingFile(row: AttachmentRow) {
    setPendingFiles((current) =>
      current.filter((_, index) => `pending-${index}` !== row.id),
    );
  }

  async function addAttachments(files: FileList | null) {
    if (!editable || !editItemId || !files?.length || attachmentBusy) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      const result = await uploadAttachments(editItemId, Array.from(files));
      setAttachments((current) => [
        ...result.attachments.reverse(),
        ...current,
      ]);
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t("todo.attachment_upload_failed", "附件上传失败"),
      );
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function uploadAttachments(itemId: string, files: File[]) {
    const uploaded = await Promise.all(
      files.map(async (file) => {
        const attachment = await editorPort.attachments.upload(itemId, file);
        return { attachment, markdown: attachment.markdown };
      }),
    );
    return {
      attachments: uploaded.map((entry) => entry.attachment),
      markdown: uploaded.map((entry) => entry.markdown).join("\n"),
    };
  }

  function pasteAttachments(files: File[]) {
    if (isCreate) {
      setPendingFiles((current) => [...current, ...files]);
      return;
    }
    if (!editable || !editItemId || attachmentBusy) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    void uploadAttachments(editItemId, files)
      .then((result) => {
        setAttachments((current) => [
          ...result.attachments.reverse(),
          ...current,
        ]);
        setDescription((current) =>
          appendAttachmentMarkdown(current, result.markdown),
        );
      })
      .catch((cause) => {
        setAttachmentError(
          cause instanceof Error
            ? cause.message
            : t("todo.attachment_upload_failed", "附件上传失败"),
        );
      })
      .finally(() => setAttachmentBusy(false));
  }

  async function openAttachment(attachment: AttachmentRow) {
    if (downloadingAttachmentId) return;
    setDownloadingAttachmentId(attachment.id);
    setAttachmentError(null);
    try {
      if (extensions?.openAttachment) {
        await extensions.openAttachment(attachment.id, attachment.display_name);
      } else {
        await editorPort.attachments.download(
          attachment.id,
          attachment.display_name,
        );
      }
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t("todo.attachment_download_failed", "附件下载失败"),
      );
    } finally {
      setDownloadingAttachmentId(null);
    }
  }

  async function downloadAttachment(attachment: AttachmentRow) {
    if (downloadingAttachmentId) return;
    setDownloadingAttachmentId(attachment.id);
    setAttachmentError(null);
    try {
      await editorPort.attachments.download(
        attachment.id,
        attachment.display_name,
      );
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t("todo.attachment_download_failed", "附件下载失败"),
      );
    } finally {
      setDownloadingAttachmentId(null);
    }
  }

  async function removeAttachment(attachment: AttachmentRow) {
    if (!editable) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      await editorPort.attachments.remove(attachment.id);
      setAttachments((current) =>
        current.filter((entry) => entry.id !== attachment.id),
      );
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error
          ? cause.message
          : t("todo.attachment_delete_failed", "附件删除失败"),
      );
    } finally {
      setAttachmentBusy(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (isCreate) void submitCreate();
      else void saveDetails();
    }
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    if (isCreate) void stageFiles(event.dataTransfer.files);
    else if (editable) void addAttachments(event.dataTransfer.files);
  }

  function commitTagDraft() {
    const tag = tagDraft.trim().replace(/,/g, "");
    if (tag) {
      setTags((current) =>
        current.includes(tag) ? current : [...current, tag],
      );
    }
    setTagDraft("");
  }

  if (selectedDelivery && item) {
    return (
      <aside className="fixed inset-y-0 right-0 z-modal flex w-full min-w-0 flex-col border-l border-border bg-background shadow-xl md:w-[calc(100%-248px)]">
        <header className="flex h-12 items-center border-b border-border px-4">
          <button
            type="button"
            onClick={() => setSelectedDelivery(null)}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-hover"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t("todo.back", "返回")}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 rounded-lg hover:bg-hover"
          >
            <X className="mx-auto h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="font-mono text-xs text-text-muted">
            {item.id} · {t("todo.delivered", "已交付")}
          </p>
          <h2 className="mt-2 text-heading-md font-semibold">{item.title}</h2>
          <article className="mt-6 whitespace-pre-wrap rounded-lg bg-muted/40 p-4 text-sm leading-6 text-text-primary">
            {selectedDelivery.markdown ||
              t("todo.no_delivery_description", "无交付说明")}
          </article>
          <h3 className="mt-6 text-xs font-semibold text-text-secondary">
            {t("todo.attachment", "附件")}
          </h3>
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {selectedDelivery.assets.map((asset) => (
              <div
                key={asset.id}
                className="flex h-10 items-center gap-2 px-3 text-sm"
              >
                <File className="h-4 w-4 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {asset.relative_path}
                </span>
                <span className="text-text-muted">{asset.size_bytes} B</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  // The Xiaohongshu-style split: task content on the left, the comment
  // activity rail on the right. Edit mode with a project always gets this
  // layout so the task detail shape matches the design even before chat
  // connectivity is available.
  const activityView =
    item &&
    editProps?.project &&
    editProps.project.task_provider !== "dingtalk_aitable"
      ? extensions?.renderActivity?.({
          item,
          project: editProps.project,
          editable,
          tasks,
          deliveries,
          selectedTaskId: props.selectedTaskId,
          workflowManagerRunId:
            typeof workflowPlan?.manager_run === "object" &&
            workflowPlan.manager_run
              ? String(
                  (workflowPlan.manager_run as Record<string, unknown>).id ??
                    "",
                )
              : undefined,
          onTaskBindingsChange: refreshTaskBindings,
          onItemChange: editProps.onUpdated,
          onOpenManagerExecutionChange: registerWorkflowManagerExecution,
          onWorkflowManagerFinished: refreshWorkflowPlan,
        })
      : null;
  const twoColumn = item !== null && editProps?.project !== undefined;

  // Property controls, shared by the single-column chip row and the
  // two-column Xiaohongshu-style rail cells. The overlay select/input keeps
  // every cell editable in place regardless of where it is rendered.
  const statusSelect = (
    <IssueDetailStatusSelect
      testId={
        isCreate ? "cloud-todo-create-status" : "cloud-todo-detail-status"
      }
      accessibleLabel={t("todo.issue_status", "状态")}
      value={status}
      onChange={setStatus}
      disabled={!editable}
      className={overlayControlClass}
      statuses={statusOptions}
      includeUnset={status === ""}
    />
  );
  const prioritySelect = (
    <IssueDetailPrioritySelect
      testId={
        isCreate ? "cloud-todo-create-priority" : "cloud-todo-detail-priority"
      }
      accessibleLabel={t("todo.issue_priority", "优先级")}
      value={priority}
      onChange={setPriority}
      disabled={!editable}
      className={overlayControlClass}
      labels={{
        none: t("todo.priority_none", "无"),
        low: t("todo.priority_low", "低"),
        medium: t("todo.priority_medium", "普通"),
        high: t("todo.priority_high", "高"),
        urgent: t("todo.priority_urgent", "紧急"),
      }}
    />
  );
  const assigneeSelect = (
    <>
      {notificationChoiceOpen ? (
        <div
          className="shared-issue-detail-confirm-backdrop"
          role="presentation"
        >
          <section
            className="shared-issue-detail-confirm"
            role="dialog"
            aria-modal="true"
          >
            <h2>{t("notifications.ask_title", "是否通知负责人")}</h2>
            <p>
              {t("notifications.ask_body", "可以选择是否向负责人发送通知。")}
            </p>
            <div>
              <button
                type="button"
                data-testid="wework-assignment-notify-confirm-cancel-button"
                onClick={() => {
                  setNotifyAssignee(false);
                  setNotificationChoiceOpen(false);
                }}
              >
                {t("notifications.without_notification", "不通知")}
              </button>
              <button
                type="button"
                data-testid="wework-assignment-notify-confirm"
                onClick={() => {
                  setNotifyAssignee(true);
                  setNotificationChoiceOpen(false);
                }}
              >
                {t("notifications.with_notification", "通知")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <IssueDetailAssigneeSelect
        testId={
          isCreate ? "cloud-todo-create-assignee" : "cloud-todo-detail-assignee"
        }
        accessibleLabel={t("todo.assignee", "负责人")}
        value={assigneeTarget}
        onChange={(target) => {
          setAssigneeTarget(target);
          setNotifyAssignee(true);
          if (
            target.startsWith("user:") &&
            target !== `user:${project?.current_user_id}`
          ) {
            setNotificationChoiceOpen(true);
          }
        }}
        disabled={!editable || !canAssign}
        className={overlayControlClass}
        members={projectMembers}
        agents={projectAgents}
        teams={wegentTeams}
        labels={{
          empty: t("todo.add_assignee", "添加负责人"),
          members: t("todo.members", "成员"),
          agents: t("todo.agents", "机器人"),
          teams: t("todo.agent_teams", "Wegent 智能体"),
        }}
      />
    </>
  );
  const parentSelect = (
    <select
      data-testid={
        isCreate ? "cloud-todo-create-parent" : "cloud-todo-detail-parent"
      }
      aria-label={t("todo.parent_issue", "父任务")}
      value={parentId}
      onChange={(event) => setParentId(event.target.value)}
      disabled={!editable}
      className={overlayControlClass}
    >
      <option value="">
        {isCreate
          ? t("todo.top_level_issue", "顶层任务")
          : t("todo.no_parent_issue", "无父任务")}
      </option>
      {parentOptions.map((candidate) => (
        <option key={candidate.id} value={candidate.id}>
          {candidate.id} · {candidate.title}
        </option>
      ))}
    </select>
  );
  const dueInput = (
    <input
      data-testid={
        isCreate ? "cloud-todo-create-due-date" : "cloud-todo-detail-due-date"
      }
      aria-label={t("todo.due_date", "截止时间")}
      type={extensions?.dueDateInputType ?? "date"}
      value={dueDate}
      onChange={(event) => setDueDate(event.target.value)}
      disabled={!editable}
      className={overlayControlClass}
    />
  );
  const statusValue = (
    <>
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          columnDotClasses[status] ?? "bg-zinc-400",
        )}
      />
      {statusLabel}
    </>
  );
  const priorityValue = (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-px text-xs font-medium",
        priorityBadgeClasses[priority],
      )}
    >
      {priority === "none"
        ? t("todo.priority_medium", "普通")
        : t(`todo.priority_${priority}`, priority)}
    </span>
  );
  const iterationText =
    item && editProps?.project
      ? (sourceCellText(item.source_cells, ["iteration", "sprint", "迭代"]) ??
        tagByPattern(tags, /^(sprint|迭代)[\s:_-]*/i) ??
        null)
      : null;
  const requirementText =
    item && editProps?.project
      ? (sourceCellText(item.source_cells, ["requirement", "需求", "req"]) ??
        tagByPattern(tags, /^(req|需求)[\s:_-]*/i) ??
        item.source_record_id ??
        null)
      : null;
  const collaboratorPreview = collaborators.slice(0, 2);
  const statusChip = (
    <span className={propChipClass}>
      <Circle className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-muted">{t("todo.issue_status", "状态")}</span>
      {statusValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {statusSelect}
    </span>
  );
  const statusHistoryTrigger = item?.status_history?.length ? (
    <button
      ref={statusHistoryTriggerRef}
      type="button"
      data-testid="cloud-todo-status-history-trigger"
      aria-label={t("todo.status_history_trigger", "查看状态历史")}
      aria-expanded={statusHistoryOpen}
      title={t("todo.status_history_trigger", "查看状态历史")}
      onClick={() => setStatusHistoryOpen((current) => !current)}
      className="relative z-10 ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-muted transition hover:bg-muted hover:text-text-primary"
    >
      <History className="h-3.5 w-3.5" />
    </button>
  ) : null;
  const priorityChip = (
    <span className={propChipClass}>
      <Flag className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-text-muted">
        {t("todo.issue_priority", "优先级")}
      </span>
      {priorityValue}
      <ChevronDown className="h-3 w-3 text-text-muted" />
      {prioritySelect}
    </span>
  );
  const tagControls = (
    <>
      {editable ? (
        <span className="task-detail-pill">
          <Plus className="h-3.5 w-3.5" />
          <input
            data-testid={
              isCreate
                ? "cloud-todo-create-tag-input"
                : "cloud-todo-detail-tag-input"
            }
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onBlur={commitTagDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitTagDraft();
              }
            }}
            placeholder={t("todo.add_tag", "添加标签")}
          />
        </span>
      ) : null}
      {tags.map((tag) => (
        <span
          key={tag}
          data-testid={`${isCreate ? "cloud-todo-create-tag" : "cloud-todo-detail-tag"}-tag-${tag}`}
          className="task-detail-pill"
        >
          # {tag}
          {editable ? (
            <button
              type="button"
              aria-label={t("todo.remove_name", "删除 {{name}}", { name: tag })}
              data-testid={`${isCreate ? "cloud-todo-create-tag" : "cloud-todo-detail-tag"}-tag-remove-${tag}`}
              onClick={() =>
                setTags((current) =>
                  current.filter((candidate) => candidate !== tag),
                )
              }
              className="flex h-4 w-4 items-center justify-center rounded-full text-text-muted transition hover:bg-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
    </>
  );
  // Single-column layout: all props stay as one wrapping chip row.
  const propChips = (
    <>
      {statusChip}
      {statusHistoryTrigger}
      {priorityChip}
      <span
        className={cn(
          propChipClass,
          !assignee && !assigneeAgent && !assigneeTeam && "text-text-muted",
        )}
      >
        {assigneeAgent || assigneeTeam ? (
          <Bot className="h-3.5 w-3.5 text-violet-600" />
        ) : (
          <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
        )}
        <span className="text-text-muted">{t("todo.assignee", "负责人")}</span>
        {assigneeTeam?.displayName ??
          assigneeTeam?.name ??
          assigneeAgent?.name ??
          assignee?.user_name ??
          t("common.add", "添加")}
        <ChevronDown className="h-3 w-3 text-text-muted" />
        {assigneeSelect}
      </span>
      {item && (
        <span
          data-testid="cloud-todo-detail-creator"
          className={cn(propChipClass, "text-text-muted")}
        >
          <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-text-muted">{t("todo.creator", "创建人")}</span>
          <span className="text-text-primary">
            {creator ??
              (item.created_by_user_id > 0
                ? `#${item.created_by_user_id}`
                : "—")}
          </span>
        </span>
      )}
      <span className={propChipClass}>
        <ListTodo className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-text-muted">
          {t("todo.parent_issue", "父任务")}
        </span>
        <span className="max-w-40 truncate">
          {parentItem
            ? `${parentItem.id} · ${parentItem.title}`
            : isCreate
              ? t("todo.top_level_issue", "顶层任务")
              : t("todo.no_parent_issue", "无父任务")}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
        {parentSelect}
      </span>
      <span className={cn(propChipClass, !dueDate && "text-text-muted")}>
        <Calendar className="h-3.5 w-3.5 text-text-muted" />
        <span className="text-text-muted">
          {t("todo.due_date", "截止时间")}
        </span>
        {dueDate ? dueDate.slice(5) : t("todo.add_date", "添加日期")}
        {dueInput}
      </span>
    </>
  );
  // Two-column layout keeps secondary metadata in the expandable rail.
  // Assignee, priority, and due date stay editable in the primary header.
  const railProps = (
    <>
      <RailProp label={t("todo.iteration", "迭代")}>
        <span className={cn(!iterationText && "text-text-muted")}>
          {iterationText?.replace(/^(sprint|迭代)[\s:_-]*/i, "") ||
            t("todo.not_set", "未设置")}
        </span>
      </RailProp>
      <RailProp
        label={t("todo.collaborators", "参与者")}
        clickable={false}
        valueClassName="overflow-visible"
      >
        <span
          className="flex min-w-0 items-center"
          data-testid="cloud-todo-collaborators"
        >
          {collaboratorPreview.map((collaborator, index) => (
            <button
              key={collaborator.id}
              title={collaborator.user_name}
              type="button"
              aria-label={t("todo.remove_collaborator", "移除参与者 {{name}}", {
                name: collaborator.user_name,
              })}
              disabled={!editable || collaboratorBusy}
              onClick={() => void removeCollaborator(collaborator)}
              className={cn(index > 0 && "-ml-2")}
            >
              <AvatarMark
                name={collaborator.user_name}
                index={index + 1}
                size="sm"
              />
            </button>
          ))}
          {collaborators.length > collaboratorPreview.length ? (
            <span className="ml-2">
              +{collaborators.length - collaboratorPreview.length}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="cloud-todo-add-collaborator"
            aria-label={t("todo.add_collaborator", "添加参与者")}
            disabled={!editable}
            onClick={() => {
              setAddingCollaborator((current) => !current);
              setCollaboratorError(null);
            }}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-text-muted transition hover:bg-muted hover:text-text-primary",
              collaboratorPreview.length > 0 && "-ml-2",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {collaborators.length === 0 ? (
            <span className="ml-2 text-text-muted">
              {t("todo.none", "暂无")}
            </span>
          ) : null}
        </span>
      </RailProp>
      {editable && addingCollaborator ? (
        <div className="col-span-full flex items-center gap-2 px-2 pb-1">
          <select
            data-testid="cloud-todo-collaborator-select"
            value={selectedCollaboratorId ?? ""}
            onChange={(event) =>
              setSelectedCollaboratorId(Number(event.target.value) || null)
            }
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-text-muted"
          >
            <option value="">
              {t("todo.select_project_member", "选择项目空间成员")}
            </option>
            {availableCollaborators.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.user_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="cloud-todo-confirm-collaborator"
            disabled={!selectedCollaboratorId || collaboratorBusy}
            onClick={() => void addCollaborator()}
            className="h-8 shrink-0 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          >
            {t("common.add", "添加")}
          </button>
        </div>
      ) : null}
      {collaboratorError ? (
        <p className="col-span-full px-2 text-xs text-destructive">
          {collaboratorError}
        </p>
      ) : null}
      <RailProp label={t("todo.requirement", "关联需求")}>
        <span
          className={cn(requirementText ? "text-blue-600" : "text-text-muted")}
        >
          {requirementText || t("todo.not_set", "未设置")}
          {requirementText ? " ↗" : ""}
        </span>
      </RailProp>
    </>
  );
  const completedChildCount = childItems.filter(
    (child) => child.status === "completed",
  ).length;

  return (
    <div
      className={cn(
        "flex items-start justify-center",
        fullScreen
          ? "fixed inset-0 z-modal bg-black/35 p-3 backdrop-blur-sm"
          : workspacePanel
            ? cn(
                "task-detail-workspace-panel-shell relative z-10 h-full min-h-0 shrink-0",
                props.workspacePanelFill && "w-full min-w-0",
              )
            : twoColumn
              ? "fixed bottom-0 right-0 top-[38px] z-modal w-[min(760px,calc(100vw-48px))]"
              : "fixed inset-0 z-modal bg-black/35 px-6 pb-6 pt-[6vh] backdrop-blur-sm",
      )}
      onMouseDown={(event) => {
        if (!workspacePanel && event.currentTarget === event.target) onClose();
      }}
    >
      <section
        data-testid={isCreate ? "cloud-todo-create-panel" : "cloud-todo-detail"}
        className={cn(
          "flex flex-col overflow-hidden rounded-2xl bg-background shadow-2xl",
          fullScreen
            ? "h-full w-full"
            : workspacePanel
              ? "todo-floating-panel-surface h-full w-full max-w-none"
              : cn(
                  "max-w-[calc(100vw-48px)]",
                  twoColumn
                    ? "h-full w-full max-w-none rounded-none border-l border-border shadow-xl"
                    : cn(
                        "max-h-[88vh]",
                        isAITableEdit ? "w-[1080px]" : "w-[760px]",
                      ),
                ),
        )}
        onKeyDown={handleKeyDown}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="sr-only">
          {isCreate
            ? t("todo.new_issue", "新建任务")
            : t("todo.issue_detail", "任务详情")}
        </span>
        <header
          className={cn(
            "flex shrink-0 items-center",
            twoColumn && !workspacePanel
              ? "h-12 border-b border-border px-4"
              : workspacePanel
                ? "task-detail-workspace-header"
                : "px-4 pt-3",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
            <Folder className="h-3.5 w-3.5" />
            <span className="truncate">
              {item
                ? `${editProps?.project?.name ?? t("todo.project_space", "项目空间")} / ${item.id}`
                : `${createProps?.project.name} · ${
                    createProps?.initialParent
                      ? t("todo.new_sub_issue", "新建子任务")
                      : t("todo.new_issue", "新建任务")
                  }`}
            </span>
          </span>
          {item && (
            <button
              type="button"
              aria-label={t("todo.copy_issue_id", "复制任务编号")}
              title={t("todo.copy_issue_id", "复制任务编号")}
              onClick={() => void navigator.clipboard?.writeText(item.id)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="flex-1" />
          {props.headerActions}
          {twoColumn && !isCreate ? (
            <>
              {editable && (dirty || saving) ? (
                <button
                  type="button"
                  data-testid="cloud-todo-save"
                  disabled={!title.trim() || saving}
                  onClick={() => void saveDetails()}
                  className={cn(
                    "mr-2 bg-text-primary px-3 font-medium text-background transition hover:opacity-90 disabled:opacity-50",
                    workspacePanel
                      ? "task-detail-workspace-save"
                      : "h-8 rounded-lg text-sm",
                  )}
                >
                  {saving
                    ? t("todo.saving", "保存中…")
                    : t("common.save", "保存")}
                </button>
              ) : null}
            </>
          ) : null}
          {showPanelControls ? (
            <>
              <button
                type="button"
                data-testid={
                  isCreate
                    ? "cloud-todo-create-fullscreen"
                    : "cloud-todo-detail-fullscreen"
                }
                onClick={() => setFullScreen((current) => !current)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                aria-label={
                  fullScreen
                    ? t("todo.exit_full_screen", "退出全屏")
                    : t("todo.full_screen", "全屏显示")
                }
              >
                {fullScreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                data-testid={
                  isCreate
                    ? "cloud-todo-modal-close"
                    : "cloud-todo-detail-close"
                }
                onClick={onClose}
                className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
                aria-label={
                  isCreate
                    ? t("common.close", "关闭")
                    : t("todo.close_issue_detail", "关闭任务详情")
                }
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : null}
        </header>

        <div
          className={cn(
            "min-h-0 flex-1",
            twoColumn
              ? workspacePanel
                ? "grid grid-cols-1 overflow-hidden bg-background"
                : "grid grid-cols-1 overflow-y-auto bg-background md:grid-cols-[minmax(0,1fr)_320px] md:overflow-hidden"
              : "overflow-y-auto",
          )}
        >
          <div
            ref={twoColumn ? detailScrollRef : undefined}
            data-testid={twoColumn ? "cloud-todo-detail-scroll" : undefined}
            className={cn(
              "pb-6 pt-2.5",
              twoColumn ? "task-detail-left md:min-h-0" : "px-14",
              workspacePanel && "task-detail-workspace-panel",
            )}
          >
            <div className={cn(twoColumn && "task-detail-left-inner")}>
              {twoColumn && item && !workspacePanel ? (
                <div className="task-detail-id-row">
                  <span>{item.id}</span>
                  <span>·</span>
                  <span>创建于 {item.created_at.slice(5, 10)}</span>
                  {item.automation ? (
                    <>
                      <span>·</span>
                      <span data-testid="cloud-todo-automation-source">
                        自动化 ·{" "}
                        {item.automation.trigger === "manual"
                          ? t("todo.manual_trigger", "手动触发")
                          : t("todo.scheduled_trigger", "定时触发")}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
              {workspacePanel && item ? (
                <div className="task-detail-workspace-meta-row">
                  <span className="task-detail-workspace-meta-pill relative">
                    {assigneeAgent || assigneeTeam ? (
                      <Bot className="h-3.5 w-3.5 text-violet-600" />
                    ) : (
                      <span className="task-detail-workspace-mini-avatar">
                        {(assignee?.user_name ?? "?").slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span>{t("todo.assignee", "负责人")}</span>
                    <span className="text-text-primary">
                      {assignee?.user_name ??
                        assigneeTeam?.displayName ??
                        assigneeTeam?.name ??
                        assigneeAgent?.name ??
                        t("todo.unassigned", "未指派")}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                    {assigneeSelect}
                  </span>
                  <span className="task-detail-workspace-meta-pill relative">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{t("todo.due_date", "截止时间")}</span>
                    <span className="text-text-primary">
                      {dueDate ? dueDate.slice(5) : t("todo.not_set", "未设置")}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                    {dueInput}
                  </span>
                </div>
              ) : null}
              <textarea
                data-testid={
                  isCreate ? "cloud-todo-title" : "cloud-todo-detail-title"
                }
                aria-label={t("todo.issue_title", "任务标题")}
                autoFocus={isCreate}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                readOnly={!editable}
                rows={1}
                maxLength={255}
                placeholder={t(
                  "todo.issue_title_placeholder",
                  "目标或事项标题",
                )}
                className={cn(
                  "block w-full resize-none overflow-hidden border-0 bg-transparent font-bold tracking-tight text-text-primary outline-none placeholder:text-text-muted",
                  twoColumn ? "task-detail-title" : "py-1.5 text-heading-lg",
                )}
              />
              {!workspacePanel ? (
                <div
                  className={cn(
                    "flex flex-wrap items-center gap-2",
                    twoColumn ? "task-detail-pill-row" : "mt-3",
                  )}
                >
                  {twoColumn ? (
                    <>
                      {statusChip}
                      {statusHistoryTrigger}
                      {priorityChip}
                      {tagControls}
                    </>
                  ) : (
                    propChips
                  )}
                </div>
              ) : null}

              {!twoColumn ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="flex shrink-0 select-none items-center gap-1.5 text-xs text-text-muted">
                    <Tag className="h-3.5 w-3.5" />
                    {t("todo.project_tags", "标签")}
                  </span>
                  <TagEditor
                    testIdPrefix={
                      isCreate
                        ? "cloud-todo-create-tag"
                        : "cloud-todo-detail-tag"
                    }
                    tags={tags}
                    onChange={setTags}
                    disabled={!editable}
                    suggestions={tagSuggestions}
                  />
                </div>
              ) : null}

              {twoColumn && !workspacePanel ? (
                <div className="task-detail-meta-line">
                  <span className="task-detail-meta-item relative cursor-pointer">
                    {assigneeAgent || assigneeTeam ? (
                      <Bot className="h-3.5 w-3.5 text-violet-600" />
                    ) : (
                      <CircleUserRound className="h-3.5 w-3.5" />
                    )}
                    {t("todo.assignee", "负责人")}
                    <span className="text-text-primary">
                      {assignee?.user_name ??
                        assigneeTeam?.displayName ??
                        assigneeTeam?.name ??
                        assigneeAgent?.name ??
                        t("todo.unassigned", "未指派")}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                    {assigneeSelect}
                    {item?.assignment_history?.length ? (
                      <button
                        ref={assignmentChainTriggerRef}
                        type="button"
                        data-testid="cloud-todo-assignment-chain-trigger"
                        aria-label={t(
                          "todo.assignment_chain_trigger",
                          "查看指派详情",
                        )}
                        aria-expanded={assignmentChainOpen}
                        title={t(
                          "todo.assignment_chain_trigger",
                          "查看指派详情",
                        )}
                        onClick={() =>
                          setAssignmentChainOpen((current) => !current)
                        }
                        className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-muted transition hover:bg-muted hover:text-text-primary"
                      >
                        <Waypoints className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </span>
                  <span className="task-detail-meta-item relative cursor-pointer">
                    <Calendar className="h-3.5 w-3.5" />
                    {t("todo.due_date", "截止时间")}
                    <span className="text-text-primary">
                      {dueDate ? dueDate.slice(5) : t("todo.not_set", "未设置")}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                    {dueInput}
                  </span>
                </div>
              ) : null}

              {!isAITableEdit ? (
                <div
                  className={cn(
                    twoColumn ? "mt-0" : "mt-3 min-h-[240px]",
                    workspacePanel && "task-detail-workspace-description",
                  )}
                >
                  <div
                    ref={workspacePanel ? descriptionCollapseRef : undefined}
                    data-overflowing={descriptionOverflowing ? "true" : "false"}
                    className={cn(
                      twoColumn && "task-detail-desc",
                      twoColumn && !descriptionExpanded && "is-collapsed",
                    )}
                  >
                    {extensions?.renderDescriptionEditor?.({
                      value: description,
                      editable,
                      onChange: setDescription,
                      onPasteFiles: pasteAttachments,
                      readAttachment: (attachmentId) =>
                        editorPort.attachments.read(attachmentId),
                    }) ?? (
                      <textarea
                        data-testid="cloud-todo-detail-description"
                        aria-label={t("todo.issue_description", "任务描述")}
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        readOnly={!editable}
                        onPaste={(event) => {
                          if (!editable) return;
                          const files = Array.from(event.clipboardData.files);
                          if (files.length > 0) pasteAttachments(files);
                        }}
                        className="min-h-[240px] w-full resize-y rounded-lg border border-border bg-transparent p-3 text-sm text-text-primary outline-none focus:border-text-muted"
                      />
                    )}
                  </div>
                  {twoColumn ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDescriptionExpanded((current) => !current)
                      }
                      className="task-detail-desc-toggle"
                    >
                      <span>
                        {descriptionExpanded
                          ? t("todo.collapse", "收起")
                          : t("todo.expand_description", "展开描述")}
                      </span>
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          descriptionExpanded && "rotate-180",
                        )}
                      />
                    </button>
                  ) : null}
                  <p
                    className={cn(
                      "mt-2.5 text-xs text-text-muted",
                      twoColumn && !workspacePanel && "hidden",
                      workspacePanel && "task-detail-desc-hint",
                    )}
                  >
                    支持 Markdown，可拖拽文件到编辑器添加附件
                  </p>
                </div>
              ) : null}
              {saveError && (
                <p className="mt-2 text-xs text-destructive">{saveError}</p>
              )}

              {workspacePanel && item ? (
                <>
                  {item.workflow?.advancement_policy === "ai" ? (
                    <IssueWorkflowPlanSection
                      plan={sharedIssueDetailWorkflowPlanView(workflowPlan)}
                      fallbackStatus={workflowPlanStatus}
                      error={workflowPlanError}
                      busy={workflowPlanBusy}
                      availableActions={{
                        approve:
                          editable &&
                          Boolean(
                            workflowPlanMethod(
                              editorPort,
                              "approveWorkflowPlan",
                            ),
                          ),
                        approveReview:
                          editable &&
                          Boolean(
                            workflowPlanMethod(
                              editorPort,
                              "approveWorkflowReview",
                            ),
                          ),
                        pause:
                          editable &&
                          Boolean(
                            workflowPlanMethod(editorPort, "pauseWorkflowPlan"),
                          ),
                        resume:
                          editable &&
                          Boolean(
                            workflowPlanMethod(
                              editorPort,
                              "resumeWorkflowPlan",
                            ),
                          ),
                        replan:
                          editable &&
                          Boolean(
                            workflowPlanMethod(
                              editorPort,
                              "replanWorkflowPlan",
                            ),
                          ),
                      }}
                      labels={{
                        title: t("todo.workflow_plan_title", "AI 编排方案"),
                        status: {
                          idle: t("todo.workflow_plan_idle", "等待触发"),
                          planning: t(
                            "todo.workflow_plan_planning",
                            "AI 正在生成方案",
                          ),
                          awaiting_approval: t(
                            "todo.workflow_plan_awaiting_approval",
                            "等待人工确认",
                          ),
                          dispatching: t(
                            "todo.workflow_plan_dispatching",
                            "正在创建并分配任务",
                          ),
                          running: t(
                            "todo.workflow_plan_running",
                            "子任务执行中",
                          ),
                          awaiting_review: t(
                            "todo.workflow_plan_awaiting_review",
                            "等待统一验收",
                          ),
                          paused: t("todo.workflow_plan_paused", "已暂停"),
                          completed: t(
                            "todo.workflow_plan_completed",
                            "已完成",
                          ),
                          failed: t(
                            "todo.workflow_plan_failed",
                            "生成方案失败",
                          ),
                        },
                        failed: t("todo.workflow_plan_failed", "生成方案失败"),
                        retry: t("todo.workflow_plan_retry", "重新生成"),
                        replan: t("todo.workflow_plan_replan", "要求重规划"),
                        approve: t("todo.workflow_plan_approve", "确认并执行"),
                        approveReview: t(
                          "todo.workflow_plan_review",
                          "验收并完成",
                        ),
                        resume: t("todo.workflow_plan_resume", "继续执行"),
                        pause: t("todo.workflow_plan_pause", "暂停"),
                        rerun: t("todo.workflow_plan_rerun", "再次执行"),
                        manager: t("todo.workflow_manager"),
                        managerEnteringQueue: t(
                          "todo.workflow_manager_entering_queue",
                        ),
                        openExecution: t(
                          "workbench.task_activity_view_execution",
                        ),
                        outcomePassed: t("todo.workflow_outcome_passed"),
                        outcomeNeedsRework: t(
                          "todo.workflow_outcome_needs_rework",
                        ),
                        taskPendingCreation: t(
                          "todo.workflow_task_pending_creation",
                        ),
                        openTask: t("todo.workflow_open_task"),
                        error: {
                          timeout: t("todo.workflow_error_timeout"),
                          offline: t("todo.workflow_error_offline"),
                          assignee: t("todo.workflow_error_assignee"),
                          model: t("todo.workflow_error_model"),
                          generic: t("todo.workflow_error_generic"),
                        },
                      }}
                      statusName={(taskStatus) =>
                        statusOptions.find((option) => option.id === taskStatus)
                          ?.name ?? taskStatus
                      }
                      onAction={(action) =>
                        mutateWorkflowPlan(
                          {
                            approve: "approveWorkflowPlan",
                            approveReview: "approveWorkflowReview",
                            pause: "pauseWorkflowPlan",
                            resume: "resumeWorkflowPlan",
                            replan: "replanWorkflowPlan",
                          }[action] as WorkflowPlanAction,
                        )
                      }
                      onOpenManagerExecution={openWorkflowManagerExecution}
                      onOpenTask={(taskId) => {
                        const child = childItems.find(
                          (candidate) => candidate.id === taskId,
                        );
                        if (child) props.onOpenChildTask?.(child);
                      }}
                    />
                  ) : null}
                  <section
                    className="task-detail-workspace-section"
                    data-testid="cloud-todo-tasks"
                  >
                    <div className="task-detail-workspace-section-head">
                      <h3 className="task-detail-workspace-section-title">
                        {displayedWorkflow?.nodes?.length
                          ? t("todo.workflow_runtime_title")
                          : props.showCurrentTaskOnly
                            ? t("todo.current_running_task")
                            : t("todo.execution_tasks")}
                      </h3>
                      <span
                        className="task-detail-workspace-count"
                        data-testid="cloud-todo-execution-task-count"
                      >
                        {displayedWorkflow?.nodes?.length ?? executionTaskCount}
                      </span>
                      {editable &&
                      props.onCreateTask &&
                      !displayedWorkflow?.nodes?.length ? (
                        <button
                          type="button"
                          data-testid="cloud-todo-create-task"
                          onClick={() => props.onCreateTask?.()}
                          className="task-detail-workspace-ghost-action"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t("todo.new_task")}
                        </button>
                      ) : null}
                    </div>
                    {displayedWorkflow?.nodes?.length ? (
                      <IssueWorkflowDag
                        translate={workflowTranslate}
                        nodes={displayedWorkflow.nodes as SharedWorkflowNode[]}
                        tasks={tasks}
                        deliveries={deliveries}
                        executionError={item.execution_error}
                        selectedTaskId={props.selectedTaskId}
                        onOpenDelivery={(delivery) =>
                          void editorPort.deliveries
                            .get(delivery.id)
                            .then(setSelectedDelivery)
                        }
                        onCreateTask={editable ? props.onCreateTask : undefined}
                        onRunAutomation={
                          editable
                            ? async (workflowNodeId, automationRuleId) => {
                                const updated =
                                  await editorPort.workflowNodes.run(
                                    String(item.cloud_project_id),
                                    item.id,
                                    workflowNodeId,
                                    automationRuleId,
                                  );
                                editProps?.onUpdated(updated);
                              }
                            : undefined
                        }
                        onOpenTask={props.onOpenTaskConversation}
                        onCompleteStage={
                          editable
                            ? async (
                                workflowNodeId,
                                action,
                                reason,
                                values,
                              ) => {
                                const stage = (
                                  displayedWorkflow.nodes as SharedWorkflowNode[]
                                ).find(
                                  (candidate) =>
                                    candidate.id === workflowNodeId,
                                );
                                if (!stage) return;
                                const updated =
                                  await editorPort.workflowNodes.complete(
                                    item.id,
                                    stage,
                                    tasks,
                                    action,
                                    reason,
                                    values,
                                  );
                                editProps?.onUpdated(updated);
                                void editorPort.deliveries
                                  .list(item.id)
                                  .then(setDeliveries);
                              }
                            : undefined
                        }
                        onDecide={
                          editable
                            ? async (workflowNodeId, action, reason) => {
                                const updated =
                                  await editorPort.workflowNodes.decide(
                                    item.id,
                                    workflowNodeId,
                                    action,
                                    reason,
                                  );
                                editProps?.onUpdated(updated);
                              }
                            : undefined
                        }
                      />
                    ) : executionTaskCount === 0 ? (
                      <p className="task-detail-workspace-empty">
                        {props.showCurrentTaskOnly
                          ? t("todo.no_running_task")
                          : t("todo.no_linked_task")}
                      </p>
                    ) : (
                      <div
                        data-testid="cloud-todo-task-list"
                        className="task-detail-flat-task-list"
                      >
                        {executionChildItems.map((child) => {
                          const assignee =
                            child.assignee_agent_name ??
                            child.assignee_team_name ??
                            child.assignee_name;
                          const childStatus =
                            statusOptions.find(
                              (option) => option.id === child.status,
                            )?.name ?? child.status;
                          return (
                            <button
                              key={child.id}
                              type="button"
                              data-testid={`cloud-todo-open-child-task-${child.id}`}
                              disabled={
                                !props.onOpenChildTask ||
                                child.can_view_detail === false
                              }
                              onClick={() => props.onOpenChildTask?.(child)}
                              className="task-detail-flat-task-row"
                            >
                              <span
                                className={cn(
                                  "task-detail-flat-task-dot",
                                  columnDotClasses[child.status],
                                )}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-text-primary">
                                  {child.title}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-text-muted">
                                  {childStatus}
                                  {assignee ? ` · ${assignee}` : ""}
                                </span>
                              </span>
                              {props.onOpenChildTask &&
                              child.can_view_detail !== false ? (
                                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                              ) : null}
                            </button>
                          );
                        })}
                        {displayedTasks.map((task) => {
                          const selected =
                            props.selectedTaskId === task.task_id;
                          return (
                            <button
                              key={task.id}
                              type="button"
                              data-testid={`cloud-todo-open-task-conversation-${task.id}`}
                              data-selected={selected ? "true" : "false"}
                              onClick={() =>
                                props.onOpenTaskConversation?.(task)
                              }
                              className="task-detail-flat-task-row"
                            >
                              <span
                                className={cn(
                                  "task-detail-flat-task-dot",
                                  selected ? "is-selected" : "is-idle",
                                )}
                              />
                              <span className="min-w-0 flex-1">
                                <span
                                  className="block truncate text-sm font-medium text-text-primary"
                                  title={task.task_title || task.task_id}
                                >
                                  {task.task_title || task.task_id}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-text-muted">
                                  {task.device_id} ·{" "}
                                  {selected
                                    ? t("todo.current_conversation", "当前会话")
                                    : t(
                                        "todo.expand_conversation",
                                        "点击展开会话",
                                      )}
                                </span>
                              </span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {showChildren ? (
                    <section
                      className="task-detail-workspace-section"
                      data-testid="cloud-todo-children"
                    >
                      <div className="task-detail-workspace-section-head">
                        <h3 className="task-detail-workspace-section-title">
                          子 Issue
                        </h3>
                        <span className="task-detail-workspace-count">
                          {childItems.length > 0
                            ? `${completedChildCount}/${childItems.length}`
                            : childItems.length}
                        </span>
                        {editable && editProps?.onAddChild ? (
                          <button
                            type="button"
                            data-testid="cloud-todo-detail-add-child"
                            onClick={editProps.onAddChild}
                            className="task-detail-workspace-ghost-action"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            添加
                          </button>
                        ) : null}
                      </div>
                      {childItems.length > 0 ? (
                        <div>
                          {childItems.map((child) => (
                            <div
                              key={child.id}
                              className={cn(
                                "task-detail-workspace-sub-row",
                                child.status === "completed" && "is-completed",
                              )}
                            >
                              <span
                                className={cn(
                                  "h-2 w-2 shrink-0 rounded-full",
                                  columnDotClasses[child.status],
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {child.title}
                              </span>
                              <span className="shrink-0 text-xs text-text-muted">
                                {
                                  statusOptions.find(
                                    (option) => option.id === child.status,
                                  )?.name
                                }
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <details className="task-detail-workspace-properties" open>
                    <summary className="task-detail-workspace-properties-toggle">
                      更多属性
                      <ChevronDown className="ml-auto h-4 w-4" />
                    </summary>
                    <div className="task-detail-workspace-properties-grid">
                      <RailProp
                        label={t("todo.issue_status", "状态")}
                        control={statusSelect}
                      >
                        {statusValue}
                        {statusHistoryTrigger}
                      </RailProp>
                      <RailProp
                        label={t("todo.issue_priority", "优先级")}
                        control={prioritySelect}
                      >
                        <span className="task-detail-workspace-tag">
                          {priority === "none"
                            ? t("todo.priority_medium", "普通")
                            : t(`todo.priority_${priority}`, priority)}
                          <ChevronDown className="h-3 w-3" />
                        </span>
                      </RailProp>
                      <RailProp
                        label={t("todo.project_tags", "标签")}
                        clickable={false}
                        valueClassName="overflow-visible"
                      >
                        <span className="task-detail-workspace-tags">
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              data-testid={`cloud-todo-detail-tag-tag-${tag}`}
                              className="task-detail-workspace-tag"
                            >
                              {tag}
                              {editable ? (
                                <button
                                  type="button"
                                  aria-label={`移除标签 ${tag}`}
                                  data-testid={`cloud-todo-detail-tag-tag-remove-${tag}`}
                                  onClick={() =>
                                    setTags((current) =>
                                      current.filter(
                                        (candidate) => candidate !== tag,
                                      ),
                                    )
                                  }
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              ) : null}
                            </span>
                          ))}
                          {editable ? (
                            <label className="task-detail-workspace-tag-add">
                              <Plus className="h-3 w-3" />
                              <span>{t("todo.add_tag", "添加标签")}</span>
                              <input
                                data-testid="cloud-todo-detail-tag-input"
                                value={tagDraft}
                                onChange={(event) =>
                                  setTagDraft(event.target.value)
                                }
                                onBlur={commitTagDraft}
                                onKeyDown={(event) => {
                                  if (
                                    event.key === "Enter" ||
                                    event.key === ","
                                  ) {
                                    event.preventDefault();
                                    commitTagDraft();
                                  }
                                }}
                              />
                            </label>
                          ) : null}
                        </span>
                      </RailProp>
                      {railProps}
                      <RailProp
                        label={t("todo.assignment", "指派")}
                        clickable={false}
                      >
                        {item.assignment_history?.length ? (
                          <button
                            ref={assignmentChainTriggerRef}
                            type="button"
                            data-testid="cloud-todo-assignment-chain-trigger"
                            aria-label={t(
                              "todo.assignment_chain_trigger",
                              "查看指派详情",
                            )}
                            aria-expanded={assignmentChainOpen}
                            onClick={() =>
                              setAssignmentChainOpen((current) => !current)
                            }
                            className="task-detail-workspace-prop-link"
                          >
                            {t("todo.assignment_chain_trigger", "查看指派详情")}
                          </button>
                        ) : (
                          <span className="text-text-muted">
                            {t("todo.none", "暂无")}
                          </span>
                        )}
                      </RailProp>
                    </div>
                  </details>

                  {deliveries.length > 0 ? (
                    <section className="task-detail-workspace-section">
                      <div className="task-detail-workspace-section-head">
                        <h3 className="task-detail-workspace-section-title">
                          交付
                        </h3>
                        <span className="task-detail-workspace-count">
                          {deliveries.length}
                        </span>
                      </div>
                      <div>
                        {deliveries.map((delivery) => (
                          <button
                            key={delivery.id}
                            type="button"
                            onClick={() =>
                              void editorPort.deliveries
                                .get(delivery.id)
                                .then(setSelectedDelivery)
                            }
                            className="task-detail-workspace-sub-row w-full text-left"
                          >
                            <Package className="h-4 w-4 shrink-0 text-text-muted" />
                            <span className="min-w-0 flex-1 truncate">
                              交付结果
                              {delivery.assets.length > 0
                                ? ` · ${t(
                                    "todo.attachment_count",
                                    "{{count}} 个附件",
                                    { count: delivery.assets.length },
                                  )}`
                                : ""}
                            </span>
                            <span className="shrink-0 text-xs text-text-muted">
                              {delivery.delivered_at?.slice(0, 10)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : null}

              {twoColumn &&
              item &&
              editProps?.project?.task_provider !== "dingtalk_aitable"
                ? (activityView ?? (
                    <section
                      data-testid="cloud-todo-detail-activity-rail-empty"
                      className="task-detail-comments"
                    >
                      <header className="task-detail-comments-head">
                        <span className="font-semibold text-text-primary">
                          {t("todo.activity", "动态")}
                        </span>
                      </header>
                      <div className="task-detail-comments-list text-sm text-text-muted">
                        {t("todo.activity_unavailable", "动态服务当前不可用")}
                      </div>
                    </section>
                  ))
                : null}

              {isAITableEdit && item && editProps?.project
                ? (extensions?.renderAITableFields?.({
                    project: editProps.project,
                    item,
                  }) ?? null)
                : null}

              {twoColumn ? <div className="sr-only">{parentSelect}</div> : null}

              {!twoColumn ? (
                <div className="mt-5">
                  <TodoAttachmentSection
                    attachments={
                      isCreate ? pendingAttachmentRows : visibleAttachments
                    }
                    busy={attachmentBusy}
                    error={attachmentError}
                    editable={editable}
                    downloadingId={downloadingAttachmentId}
                    onAdd={isCreate ? stageFiles : addAttachments}
                    onOpen={isCreate ? undefined : openAttachment}
                    onDownload={
                      !isCreate && extensions?.openAttachment
                        ? downloadAttachment
                        : undefined
                    }
                    onRemove={isCreate ? removePendingFile : removeAttachment}
                    translate={t}
                  />
                </div>
              ) : null}

              {item && (
                <>
                  {!twoColumn && showChildren ? (
                    <section className="mt-7" data-testid="cloud-todo-children">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-muted">
                        <h3 className="text-sm font-medium text-text-muted">
                          {t("todo.sub_issues", "子任务")}
                        </h3>
                        <span className="ml-2 text-xs font-normal text-text-muted">
                          {twoColumn && childItems.length > 0
                            ? `${completedChildCount}/${childItems.length}`
                            : childItems.length}
                        </span>
                        {editable && editProps?.onAddChild ? (
                          <button
                            type="button"
                            data-testid="cloud-todo-detail-add-child"
                            onClick={editProps.onAddChild}
                            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition hover:bg-muted hover:text-text-primary"
                          >
                            <Plus className="h-3 w-3" />{" "}
                            {t("todo.create_sub_issue", "新建子任务")}
                          </button>
                        ) : null}
                      </div>
                      {twoColumn && childItems.length > 0 ? (
                        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-text-primary transition-all"
                            style={{
                              width: `${(completedChildCount / childItems.length) * 100}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      {childItems.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-text-muted">
                          {t("todo.no_sub_issues", "暂无子任务")}
                        </p>
                      ) : (
                        <div>
                          {childItems.map((child) => (
                            <div
                              key={child.id}
                              className="mb-2 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                            >
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  columnDotClasses[child.status],
                                )}
                              />
                              <span className="shrink-0 font-mono text-xs text-text-muted">
                                {child.id}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {child.title}
                              </span>
                              <span className="shrink-0 text-xs text-text-muted">
                                {
                                  statusOptions.find(
                                    (option) => option.id === child.status,
                                  )?.name
                                }
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  ) : null}
                  {!twoColumn ? (
                    <section
                      className="mt-7"
                      data-testid="cloud-todo-collaborators"
                    >
                      <div className="flex h-8 items-center">
                        <h3 className="text-sm font-semibold">
                          {t("todo.collaborators", "参与者")}
                        </h3>
                        <span className="ml-2 text-xs font-normal text-text-muted">
                          {collaborators.length}
                        </span>
                        {editable ? (
                          <button
                            type="button"
                            data-testid="cloud-todo-add-collaborator"
                            onClick={() => {
                              setAddingCollaborator((current) => !current);
                              setCollaboratorError(null);
                            }}
                            className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-muted transition hover:text-text-primary"
                          >
                            <Plus className="h-3 w-3" />
                            {t("todo.add_collaborator", "添加参与者")}
                          </button>
                        ) : null}
                      </div>
                      {addingCollaborator && (
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            data-testid="cloud-todo-collaborator-select"
                            value={selectedCollaboratorId ?? ""}
                            onChange={(event) =>
                              setSelectedCollaboratorId(
                                Number(event.target.value) || null,
                              )
                            }
                            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
                          >
                            <option value="">
                              {t(
                                "todo.select_project_member",
                                "选择项目空间成员",
                              )}
                            </option>
                            {availableCollaborators.map((member) => (
                              <option
                                key={member.user_id}
                                value={member.user_id}
                              >
                                {member.user_name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            data-testid="cloud-todo-confirm-collaborator"
                            disabled={
                              !selectedCollaboratorId || collaboratorBusy
                            }
                            onClick={() => void addCollaborator()}
                            className="h-9 shrink-0 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                          >
                            {t("common.add", "添加")}
                          </button>
                        </div>
                      )}
                      {collaborators.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                          {t("todo.no_collaborators", "暂无参与者")}
                        </p>
                      ) : (
                        <div className="mt-1">
                          {collaborators.map((collaborator) => (
                            <div
                              key={collaborator.id}
                              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/60"
                            >
                              <span
                                className={cn(
                                  "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background",
                                  memberAvatarClasses[0],
                                )}
                              >
                                {collaborator.user_name
                                  .slice(0, 1)
                                  .toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {collaborator.user_name}
                              </span>
                              {collaborator.source !== "manual" && (
                                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
                                  {t("todo.auto_joined", "自动加入")}
                                </span>
                              )}
                              {editable ? (
                                <button
                                  type="button"
                                  aria-label={t(
                                    "todo.remove_collaborator",
                                    "移除参与者 {{name}}",
                                    { name: collaborator.user_name },
                                  )}
                                  disabled={collaboratorBusy}
                                  onClick={() =>
                                    void removeCollaborator(collaborator)
                                  }
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-background hover:text-text-primary disabled:opacity-40"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                      {collaboratorError && (
                        <p className="mt-2 text-xs text-destructive">
                          {collaboratorError}
                        </p>
                      )}
                    </section>
                  ) : null}
                  {!twoColumn ? (
                    <>
                      <section className="mt-7">
                        <h3 className="flex h-8 items-center text-sm font-semibold">
                          {t("todo.execution_history", "执行记录")}
                        </h3>
                        {tasks.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                            {t("todo.no_local_task", "尚未关联本地任务")}
                          </p>
                        ) : (
                          <div className="mt-1">
                            {tasks.map((task) => (
                              <div
                                key={task.id}
                                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-muted/60"
                              >
                                <Link2 className="h-4 w-4 shrink-0 text-text-muted" />
                                <span
                                  className="min-w-0 flex-1 truncate"
                                  title={task.task_title || task.task_id}
                                >
                                  {task.task_title || task.task_id}
                                </span>
                                <span className="shrink-0 text-text-muted">
                                  {task.device_id}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                      <section className="mt-7">
                        <h3 className="flex h-8 items-center text-sm font-semibold">
                          {t("todo.deliveries", "交付")}
                        </h3>
                        <div className="mt-1 space-y-1">
                          {deliveries.map((delivery) => (
                            <button
                              key={delivery.id}
                              type="button"
                              onClick={() =>
                                void editorPort.deliveries
                                  .get(delivery.id)
                                  .then(setSelectedDelivery)
                              }
                              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-xs transition-colors hover:bg-muted/60"
                            >
                              <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                              <span>
                                {t(
                                  "todo.attachment_count",
                                  "{{count}} 个附件",
                                  { count: delivery.assets.length },
                                )}
                              </span>
                              <span className="ml-auto shrink-0 text-text-muted">
                                {delivery.delivered_at?.slice(0, 10)}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                            </button>
                          ))}
                        </div>
                      </section>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
          {twoColumn && !workspacePanel ? (
            <aside
              data-testid="cloud-todo-detail-activity-rail"
              className="task-detail-slim-rail flex min-h-0 flex-col border-t border-border bg-muted/40 md:border-l md:border-t-0"
            >
              <div className="shrink-0 border-b border-border bg-background px-3 py-2.5">
                <div className="grid grid-cols-1 gap-0.5">{railProps}</div>
              </div>
              {item ? (
                <div className="task-detail-rail-sections">
                  {showChildren ? (
                    <section
                      className="task-detail-rail-section"
                      data-testid="cloud-todo-children"
                    >
                      <div className="task-detail-section-label">
                        <h3>
                          <ListTodo className="icon" />
                          {t("todo.sub_issues", "子任务")}
                        </h3>
                        <span className="count">
                          {childItems.length > 0
                            ? `${completedChildCount}/${childItems.length}`
                            : childItems.length}
                        </span>
                        {editable && editProps?.onAddChild ? (
                          <button
                            type="button"
                            data-testid="cloud-todo-detail-add-child"
                            onClick={editProps.onAddChild}
                            className="add"
                          >
                            ＋ {t("common.add", "添加")}
                          </button>
                        ) : null}
                      </div>
                      {childItems.length > 0 ? (
                        <div className="progress-track">
                          <div
                            className="progress-fill"
                            style={{
                              width: `${(completedChildCount / childItems.length) * 100}%`,
                            }}
                          />
                        </div>
                      ) : null}
                      {childItems.length === 0 ? (
                        <p className="task-detail-rail-empty">
                          {t("todo.no_sub_issues", "暂无子任务")}
                        </p>
                      ) : (
                        <>
                          <div
                            className={cn(
                              "task-detail-rail-subtasks",
                              childRailExpanded && "expanded-scroll",
                            )}
                          >
                            {visibleRailChildren.map((child) => (
                              <div key={child.id} className="subtask">
                                <span
                                  className={cn(
                                    "checkbox",
                                    child.status === "completed" && "is-done",
                                  )}
                                >
                                  {child.status === "completed" ? "✓" : null}
                                </span>
                                <span className="subtask-title">
                                  {child.title}
                                </span>
                                <span className="who">
                                  {
                                    statusOptions.find(
                                      (option) => option.id === child.status,
                                    )?.name
                                  }
                                </span>
                              </div>
                            ))}
                          </div>
                          {childItems.length > 2 && (
                            <button
                              type="button"
                              className="task-detail-rail-more"
                              onClick={() => toggleRailSection("children")}
                            >
                              {childRailExpanded
                                ? t("todo.collapse", "收起")
                                : t(
                                    "todo.view_all_count",
                                    "查看全部 {{count}} 个",
                                    { count: childItems.length },
                                  )}
                            </button>
                          )}
                        </>
                      )}
                    </section>
                  ) : null}
                  <TodoAttachmentSection
                    attachments={visibleAttachments}
                    busy={attachmentBusy}
                    error={attachmentError}
                    editable={editable}
                    compactRail
                    downloadingId={downloadingAttachmentId}
                    onAdd={addAttachments}
                    onOpen={openAttachment}
                    onDownload={
                      extensions?.openAttachment
                        ? downloadAttachment
                        : undefined
                    }
                    onRemove={removeAttachment}
                    translate={t}
                  />
                  <section className="task-detail-rail-section">
                    <div className="task-detail-section-label">
                      <h3>
                        <Link2 className="icon" />
                        {t("todo.execution_history", "执行记录")}
                      </h3>
                      <span className="count">{tasks.length}</span>
                    </div>
                    {tasks.length === 0 ? (
                      <p className="task-detail-rail-empty">
                        {t("todo.no_local_task", "尚未关联本地任务")}
                      </p>
                    ) : (
                      <>
                        <div
                          className={cn(
                            "task-detail-rail-executions",
                            executionRailExpanded && "expanded-scroll",
                          )}
                        >
                          {visibleRailTasks.map((task) => (
                            <button
                              key={task.id}
                              type="button"
                              data-testid={`cloud-todo-open-task-conversation-${task.id}`}
                              onClick={() =>
                                props.onOpenTaskConversation?.(task)
                              }
                              className="task-detail-rail-execution w-full text-left transition hover:bg-muted"
                            >
                              <span className="task-detail-rail-icon">
                                <Link2 className="icon" />
                              </span>
                              <span className="task-detail-rail-content">
                                <span
                                  className="task-detail-rail-name"
                                  title={task.task_title || task.task_id}
                                >
                                  {task.task_title || task.task_id}
                                </span>
                                <span className="task-detail-rail-detail">
                                  <span>{task.device_id}</span>
                                  <span>{t("todo.linked", "已关联")}</span>
                                </span>
                              </span>
                              <span className="task-detail-rail-badges">
                                <span className="task-detail-mini-badge">
                                  {t(
                                    "workbench.quick_view_conversation",
                                    "查看对话",
                                  )}
                                </span>
                                <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                              </span>
                            </button>
                          ))}
                        </div>
                        {tasks.length > 2 && (
                          <button
                            type="button"
                            className="task-detail-rail-more"
                            onClick={() => toggleRailSection("executions")}
                          >
                            {executionRailExpanded
                              ? t("todo.collapse", "收起")
                              : t(
                                  "todo.view_all_count",
                                  "查看全部 {{count}} 个",
                                  { count: tasks.length },
                                )}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                  <section className="task-detail-rail-section">
                    <div className="task-detail-section-label">
                      <h3>
                        <FileText className="icon" />
                        {t("todo.deliveries", "交付")}
                      </h3>
                      <span className="count">{deliveries.length}</span>
                    </div>
                    {deliveries.length === 0 ? (
                      <p className="task-detail-rail-empty">
                        {t("todo.no_deliveries", "暂无交付")}
                      </p>
                    ) : (
                      <>
                        <div
                          className={cn(
                            "task-detail-rail-deliveries",
                            deliveryRailExpanded && "expanded-scroll",
                          )}
                        >
                          {visibleRailDeliveries.map((delivery) => (
                            <button
                              key={delivery.id}
                              type="button"
                              onClick={() =>
                                void editorPort.deliveries
                                  .get(delivery.id)
                                  .then(setSelectedDelivery)
                              }
                              className="task-detail-rail-delivery w-full text-left"
                            >
                              <span className="task-detail-rail-icon">
                                <FileText className="icon" />
                              </span>
                              <span className="task-detail-rail-name">
                                {delivery.assets.length > 0
                                  ? t(
                                      "todo.attachment_count",
                                      "{{count}} 个附件",
                                      { count: delivery.assets.length },
                                    )
                                  : t("todo.delivery_result", "交付结果")}
                              </span>
                              <span className="task-detail-rail-meta">
                                {delivery.delivered_at?.slice(0, 10)}
                              </span>
                            </button>
                          ))}
                        </div>
                        {deliveries.length > 2 && (
                          <button
                            type="button"
                            className="task-detail-rail-more"
                            onClick={() => toggleRailSection("deliveries")}
                          >
                            {deliveryRailExpanded
                              ? t("todo.collapse", "收起")
                              : t(
                                  "todo.view_all_count",
                                  "查看全部 {{count}} 个",
                                  { count: deliveries.length },
                                )}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>

        {workspacePanel && item ? (
          <div
            data-testid="cloud-todo-attachment-footer"
            className="task-detail-workspace-attachments task-detail-rail-sections"
          >
            <TodoAttachmentSection
              attachments={visibleAttachments}
              busy={attachmentBusy}
              error={attachmentError}
              editable={editable}
              compactRail
              downloadingId={downloadingAttachmentId}
              onAdd={addAttachments}
              onOpen={openAttachment}
              onDownload={
                extensions?.openAttachment ? downloadAttachment : undefined
              }
              onRemove={removeAttachment}
              translate={t}
            />
          </div>
        ) : null}

        {!twoColumn ? (
          <>
            {isCreate && extensions?.renderCreateOptions ? (
              <div className="shrink-0 border-t border-border px-5 py-3">
                {extensions.renderCreateOptions({ saving })}
              </div>
            ) : null}
            <footer className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
              <span className="text-xs text-text-muted">
                {isCreate
                  ? t(
                      "todo.create_shortcut_hint",
                      "ESC 关闭 · ⌘↵ 创建{{draft}}",
                      {
                        draft: hasDraftContent
                          ? ` · ${t("todo.draft_saved", "草稿已保存")}`
                          : "",
                      },
                    )
                  : t("todo.save_shortcut_hint", "ESC 关闭 · ⌘↵ 保存")}
              </span>
              <span className="flex-1" />
              {isCreate ? (
                <>
                  <button
                    type="button"
                    data-testid="cloud-todo-create-confirm"
                    disabled={!title.trim() || saving}
                    onClick={() => void submitCreate()}
                    className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  >
                    {saving
                      ? t("todo.creating_issue", "正在创建…")
                      : t("todo.create_issue", "创建任务")}
                  </button>
                </>
              ) : (
                <>
                  {editable && dirty && (
                    <button
                      type="button"
                      data-testid="cloud-todo-save"
                      disabled={!title.trim() || saving}
                      onClick={() => void saveDetails()}
                      className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                    >
                      {saving
                        ? t("todo.saving_issue", "正在保存…")
                        : t("common.save", "保存")}
                    </button>
                  )}
                </>
              )}
            </footer>
          </>
        ) : null}
      </section>
      {assignmentChainOpen && item?.assignment_history?.length
        ? (extensions?.renderAssignmentHistory?.({
            anchor: assignmentChainTriggerRef.current,
            entries: item.assignment_history,
            members: projectMembers,
            onClose: () => setAssignmentChainOpen(false),
          }) ?? null)
        : null}
      {statusHistoryOpen && item?.status_history?.length
        ? (extensions?.renderStatusHistory?.({
            anchor: statusHistoryTriggerRef.current,
            entries: item.status_history,
            members: projectMembers,
            onClose: () => setStatusHistoryOpen(false),
          }) ?? null)
        : null}
    </div>
  );
}

export const SharedIssueDetailEditor = TodoEditor;
export type SharedIssueDetailEditorProps = TodoEditorProps;
