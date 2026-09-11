// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { CollaborationProjectSummary } from "../CollaborationProjectSummary";
import {
  createWorkspaceHomeSnapshot,
  workspaceProjectKey,
  workspaceProjectMatchesQuery,
  type WorkspaceHomeItem,
  type WorkspaceHomeMember,
  type WorkspaceHomeMyWorkItem,
  type WorkspaceHomeProject,
} from "./model";

interface WorkspaceIconProps {
  className?: string;
}

type WorkspaceIcon = ComponentType<WorkspaceIconProps>;

export interface WorkspaceProjectsHomeHost {
  icons: {
    Check: WorkspaceIcon;
    Cloud: WorkspaceIcon;
    Copy: WorkspaceIcon;
    HardDrive: WorkspaceIcon;
    Plus: WorkspaceIcon;
    Search: WorkspaceIcon;
    Settings: WorkspaceIcon;
  };
  translate(
    key: string,
    fallback: string,
    options?: Record<string, string | number>,
  ): string;
  copyText(text: string): Promise<void>;
  formatRelativeTime(value: string): string;
  renderTooltip(options: {
    label: string;
    align: "end";
    children: ReactNode;
  }): ReactNode;
  renderModal(options: {
    title: string;
    width: "wide";
    onClose(): void;
    children: ReactNode;
  }): ReactNode;
}

export interface WorkspaceProjectsHomeProps<
  Project extends WorkspaceHomeProject,
  Item extends WorkspaceHomeItem,
  MyWorkItem extends WorkspaceHomeMyWorkItem,
  Member extends WorkspaceHomeMember,
> {
  projects: Project[];
  projectCounts: Record<string, number>;
  projectMembers: Record<string, Member[]>;
  projectItems: Record<string, Item[]>;
  myWork: MyWorkItem[];
  searchQuery: string;
  createProjectTestId?: string;
  host: WorkspaceProjectsHomeHost;
  onCreateProject(): void;
  onSelectProject(project: Project): void;
  onManageProject(project: Project): void;
  onSelectItem(item: MyWorkItem): void;
  onOpenMyWork?: () => void;
}

const HOME_VISIBLE_SPACE_ROWS = 5;
const SPACE_ROW_HEIGHT_PX = 45;
const MEMBER_AVATAR_CLASSES = [
  "bg-gradient-to-br from-indigo-400 to-indigo-500",
  "bg-gradient-to-br from-emerald-400 to-emerald-500",
  "bg-gradient-to-br from-amber-400 to-amber-500",
];

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function memberNameById(
  members: WorkspaceHomeMember[],
  userId: number | null,
): string | null {
  if (userId === null) return null;
  return members.find((member) => member.user_id === userId)?.user_name ?? null;
}

function statusLabel(status: string, host: WorkspaceProjectsHomeHost): string {
  const labels: Record<string, string> = {
    inbox: host.translate("todo.status_inbox", "收集箱"),
    pending: host.translate("todo.status_pending", "待开始"),
    in_progress: host.translate("todo.status_in_progress", "进行中"),
    in_review: host.translate("todo.status_in_review", "待确认"),
    completed: host.translate("todo.status_completed", "已完成"),
  };
  return labels[status] ?? status;
}

interface ProjectSpaceRowProps<
  Project extends WorkspaceHomeProject,
  Member extends WorkspaceHomeMember,
> {
  project: Project;
  members: Member[];
  host: WorkspaceProjectsHomeHost;
  openLabel: string;
  manageLabel: string;
  localLabel: string;
  taskCountLabel: string;
  memberCountLabel: string;
  onOpen(): void;
  onManage?(): void;
}

function ProjectSpaceRow<
  Project extends WorkspaceHomeProject,
  Member extends WorkspaceHomeMember,
>({
  project,
  members,
  host,
  openLabel,
  manageLabel,
  localLabel,
  taskCountLabel,
  memberCountLabel,
  onOpen,
  onManage,
}: ProjectSpaceRowProps<Project, Member>) {
  const LocationIcon =
    project.location === "local" ? host.icons.HardDrive : host.icons.Cloud;
  const [copied, setCopied] = useState(false);

  const copyProjectId = async () => {
    await host.copyText(String(project.id));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group grid h-11 w-full cursor-pointer grid-cols-[minmax(0,1fr)_64px_84px_108px] items-center border-b border-border px-2 text-left transition hover:bg-muted/60"
    >
      <CollaborationProjectSummary
        project={project}
        description={
          project.location === "local" ? localLabel : project.project_key
        }
        leading={<LocationIcon className="h-4 w-4 shrink-0 text-text-muted" />}
      />
      <span className="text-xs text-text-muted">{taskCountLabel}</span>
      <span className="text-xs text-text-muted">
        {project.updated_at.slice(5, 10)}
      </span>
      <span className="flex items-center">
        {onManage ? (
          <span className="hidden items-center gap-1 group-hover:flex">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              className="rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted"
            >
              {openLabel}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onManage();
              }}
              className="rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted"
            >
              {manageLabel}
            </button>
          </span>
        ) : null}
        <span
          className={classNames(
            "flex items-center",
            onManage && "group-hover:hidden",
          )}
        >
          {project.location === "local" ? (
            <span className="text-xs text-text-muted">{localLabel}</span>
          ) : (
            <>
              {members.slice(0, 2).map((member, memberIndex) => (
                <span
                  key={member.user_id}
                  className={classNames(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background ring-2 ring-background",
                    MEMBER_AVATAR_CLASSES[
                      memberIndex % MEMBER_AVATAR_CLASSES.length
                    ],
                    memberIndex > 0 && "-ml-1",
                  )}
                >
                  {member.user_name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              <span className="ml-1.5 text-xs text-text-muted">
                {memberCountLabel}
              </span>
            </>
          )}
        </span>
        {host.renderTooltip({
          label: copied
            ? host.translate("todo.project_id_copied", "项目 ID 已复制")
            : host.translate("todo.copy_project_id", "复制项目 ID"),
          align: "end",
          children: (
            <button
              type="button"
              data-testid={`cloud-project-copy-id-${project.id}`}
              onClick={(event) => {
                event.stopPropagation();
                void copyProjectId();
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
              aria-label={
                copied
                  ? host.translate("todo.project_id_copied", "项目 ID 已复制")
                  : host.translate("todo.copy_project_id", "复制项目 ID")
              }
            >
              {copied ? (
                <host.icons.Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <host.icons.Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ),
        })}
      </span>
    </div>
  );
}

export function WorkspaceProjectsHome<
  Project extends WorkspaceHomeProject,
  Item extends WorkspaceHomeItem,
  MyWorkItem extends WorkspaceHomeMyWorkItem,
  Member extends WorkspaceHomeMember,
>({
  projects,
  projectCounts,
  projectMembers,
  projectItems,
  myWork,
  searchQuery,
  createProjectTestId = "cloud-projects-home-create",
  host,
  onCreateProject,
  onSelectProject,
  onManageProject,
  onSelectItem,
  onOpenMyWork,
}: WorkspaceProjectsHomeProps<Project, Item, MyWorkItem, Member>) {
  const [nowMs] = useState(() => Date.now());
  const snapshot = useMemo(
    () =>
      createWorkspaceHomeSnapshot({
        projects,
        projectItems,
        myWork,
        searchQuery,
        nowMs,
      }),
    [projects, projectItems, myWork, searchQuery, nowMs],
  );
  const [manageOpen, setManageOpen] = useState(false);
  const [manageQuery, setManageQuery] = useState("");
  const manageProjects = useMemo(
    () =>
      snapshot.sortedProjects.filter((project) =>
        workspaceProjectMatchesQuery(project, manageQuery),
      ),
    [snapshot.sortedProjects, manageQuery],
  );

  const stats = [
    {
      label: host.translate("todo.home_stat_projects", "项目空间总数"),
      value: snapshot.stats.projectCount,
    },
    {
      label: host.translate("todo.home_stat_total_items", "总任务数"),
      value: snapshot.stats.itemCount,
    },
    {
      label: host.translate("todo.home_stat_completed", "已完成任务"),
      value: snapshot.stats.completedCount,
    },
    {
      label: host.translate("todo.home_stat_week_new", "本周新增"),
      value: snapshot.stats.weeklyNewCount,
    },
    {
      label: host.translate("todo.home_stat_week_completed", "本周完成"),
      value: snapshot.stats.weeklyCompletedCount,
    },
    {
      label: host.translate("todo.home_stat_in_progress", "进行中"),
      value: snapshot.stats.inProgressCount,
    },
  ];

  const renderProjectRow = (
    project: Project,
    options?: { onOpen(): void; onManage(): void },
  ) => {
    const key = workspaceProjectKey(project);
    const members = projectMembers[key] ?? [];
    return (
      <ProjectSpaceRow
        key={key}
        project={project}
        members={members}
        host={host}
        openLabel={host.translate("todo.home_open", "打开")}
        manageLabel={host.translate("todo.home_manage", "管理")}
        localLabel={host.translate("todo.location_local", "本地")}
        taskCountLabel={host.translate(
          "todo.home_task_count",
          "{{count}} 任务",
          {
            count: projectCounts[key] ?? 0,
          },
        )}
        memberCountLabel={host.translate(
          "todo.home_member_count",
          "{{count}} 人",
          {
            count: members.length,
          },
        )}
        onOpen={options?.onOpen ?? (() => onSelectProject(project))}
        onManage={options?.onManage}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[880px]">
        <div className="flex items-start">
          <div>
            <h1 className="text-heading-md font-semibold">
              {host.translate("todo.projects_home", "项目空间")}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {host.translate(
                "todo.projects_home_subtitle",
                "跨项目的个人工作台与项目空间概览",
              )}
            </p>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            data-testid={createProjectTestId}
            onClick={onCreateProject}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90"
          >
            <host.icons.Plus className="h-3.5 w-3.5" />{" "}
            {host.translate("todo.new_project_space", "新建项目空间")}
          </button>
        </div>

        <div className="mt-6 grid grid-cols-6 gap-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-border px-4 py-3.5"
            >
              <div className="text-heading-md font-semibold">{stat.value}</div>
              <div className="mt-0.5 text-xs text-text-muted">{stat.label}</div>
            </div>
          ))}
        </div>

        <div
          className={classNames(
            "mt-7 grid gap-9",
            onOpenMyWork ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          <section>
            <header className="mb-1 flex items-center text-sm font-semibold">
              {host.translate("todo.home_recent_activity", "最近动态")}
              {onOpenMyWork && (
                <button
                  type="button"
                  onClick={onOpenMyWork}
                  className="ml-auto text-xs font-normal text-text-muted transition hover:text-text-primary"
                >
                  {host.translate("todo.home_view_all", "全部")} →
                </button>
              )}
            </header>
            {snapshot.recentActivity.length === 0 ? (
              <p className="px-2 py-3 text-sm text-text-muted">
                {host.translate("todo.home_no_activity", "暂无动态")}
              </p>
            ) : (
              snapshot.recentActivity.map(({ item, spaceKey }, itemIndex) => {
                const project = snapshot.projectByKey.get(spaceKey);
                const members = projectMembers[spaceKey] ?? [];
                const actorName =
                  memberNameById(members, item.assignee_user_id) ??
                  item.created_by_user_name ??
                  memberNameById(members, item.created_by_user_id) ??
                  host.translate("todo.home_activity_someone", "有人");
                const actionLabel =
                  item.status === "completed"
                    ? host.translate(
                        "todo.home_activity_completed",
                        "完成了任务",
                      )
                    : host.translate(
                        "todo.home_activity_updated",
                        "更新了任务",
                      );
                return (
                  <button
                    key={`${spaceKey}:${item.id}`}
                    type="button"
                    onClick={() => {
                      if (project) onSelectProject(project);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left transition hover:bg-muted/60"
                  >
                    <span
                      className={classNames(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background",
                        MEMBER_AVATAR_CLASSES[
                          itemIndex % MEMBER_AVATAR_CLASSES.length
                        ],
                      )}
                    >
                      {actorName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className="font-medium">
                          {actorName} {actionLabel}「{item.title}」
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {project?.name ?? ""} · {statusLabel(item.status, host)}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 text-xs text-text-muted">
                      {host.formatRelativeTime(item.updated_at)}
                    </span>
                  </button>
                );
              })
            )}
          </section>

          {onOpenMyWork && (
            <section>
              <header className="mb-1 flex items-center text-sm font-semibold">
                {host.translate("todo.home_my_todos", "待我处理")}
                <button
                  type="button"
                  data-testid="cloud-projects-home-my-work"
                  onClick={onOpenMyWork}
                  className="ml-auto text-xs font-normal text-text-muted transition hover:text-text-primary"
                >
                  {host.translate("todo.my_work", "我的工作")} →
                </button>
              </header>
              {snapshot.myTodos.length === 0 ? (
                <p className="px-2 py-3 text-sm text-text-muted">
                  {host.translate("todo.home_no_todos", "暂无待处理事项")}
                </p>
              ) : (
                snapshot.myTodos.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`cloud-projects-home-todo-${item.id}`}
                    onClick={() => onSelectItem(item)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-muted/60"
                  >
                    <span
                      className={classNames(
                        "h-2 w-2 shrink-0 rounded-full",
                        item.status === "in_review"
                          ? "bg-violet-500"
                          : "bg-indigo-500",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {item.title}
                    </span>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                      {item.project_key}
                    </span>
                  </button>
                ))
              )}
            </section>
          )}
        </div>

        <section className="mt-8">
          <header className="mb-1 flex items-center text-sm font-semibold">
            {host.translate("todo.home_all_spaces", "全部空间")}
            <button
              type="button"
              data-testid="cloud-projects-home-manage"
              onClick={() => {
                setManageQuery("");
                setManageOpen(true);
              }}
              className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-text-muted transition hover:text-text-primary"
            >
              <host.icons.Settings className="h-3.5 w-3.5" />
              {host.translate("todo.home_manage", "管理")}
            </button>
          </header>
          <div
            className="overflow-y-auto border-t border-border"
            style={{ maxHeight: HOME_VISIBLE_SPACE_ROWS * SPACE_ROW_HEIGHT_PX }}
          >
            {snapshot.sortedProjects.map((project) =>
              renderProjectRow(project),
            )}
          </div>
        </section>

        <p className="mt-5 text-xs text-text-muted">
          {host.translate(
            "todo.projects_home_footnote",
            "本地空间保存在当前设备；云端空间可与项目成员共享任务、文件和交付。",
          )}
        </p>
      </div>

      {manageOpen
        ? host.renderModal({
            title: host.translate("todo.home_manage_title", "管理项目空间"),
            width: "wide",
            onClose: () => setManageOpen(false),
            children: (
              <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4">
                <div className="relative shrink-0">
                  <host.icons.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    autoFocus
                    data-testid="cloud-projects-manage-search"
                    value={manageQuery}
                    onChange={(event) => setManageQuery(event.target.value)}
                    placeholder={host.translate(
                      "todo.home_manage_search",
                      "搜索项目空间",
                    )}
                    className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition focus:border-text-muted"
                  />
                </div>
                <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-border">
                  {manageProjects.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-text-muted">
                      {host.translate(
                        "todo.home_manage_empty",
                        "没有匹配的项目空间",
                      )}
                    </p>
                  ) : (
                    manageProjects.map((project) =>
                      renderProjectRow(project, {
                        onOpen: () => {
                          setManageOpen(false);
                          onSelectProject(project);
                        },
                        onManage: () => {
                          setManageOpen(false);
                          onManageProject(project);
                        },
                      }),
                    )
                  )}
                </div>
              </div>
            ),
          })
        : null}
    </div>
  );
}
