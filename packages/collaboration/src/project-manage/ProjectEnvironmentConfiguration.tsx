// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type { CollaborationTranslate } from "../i18n";
import type {
  WorkspaceGitBranch,
  WorkspaceGitRepository,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironmentRepository,
  CollaborationExecutionEnvironmentSetupStep,
} from "../types";
import { repositoryKey } from "./environmentConfiguration";

interface Props {
  testIdPrefix: string;
  translate: CollaborationTranslate;
  canManage: boolean;
  saving: boolean;
  workspacePolicy: "git_worktree" | "project";
  onWorkspacePolicyChange(value: "git_worktree" | "project"): void;
  repositories: Array<
    CollaborationExecutionEnvironmentRepository & { id: string }
  >;
  setupSteps: Array<
    CollaborationExecutionEnvironmentSetupStep & { id: string }
  >;
  repositoryOptions: WorkspaceGitRepository[] | null;
  repositoriesByUrl: Map<string, WorkspaceGitRepository>;
  repositoriesLoadFailed: boolean;
  branchesByRepository: Record<
    string,
    { status: "loading" | "ready" | "error"; branches: WorkspaceGitBranch[] }
  >;
  loadRepositoryOptions(): Promise<void>;
  loadBranches(option: WorkspaceGitRepository): Promise<void>;
  selectRepository(id: string, key: string): void;
  updateRepository(
    id: string,
    patch: Partial<CollaborationExecutionEnvironmentRepository>,
  ): void;
  updateRepositoryUrl(id: string, url: string): void;
  removeRepository(id: string): void;
  addRepository(): void;
  addSetupStep(): void;
  removeSetupStep(id: string): void;
  updateSetupStep(
    id: string,
    patch: Partial<CollaborationExecutionEnvironmentSetupStep>,
  ): void;
  configurationError: string;
  configurationSaved: boolean;
  configurationDirty: boolean;
  saveConfiguration(): Promise<void>;
}
// Keep draft values selectable when they are absent from the repository catalog.
const CUSTOM_REPOSITORY_VALUE = "__custom_repository__";
const CUSTOM_REF_VALUE = "__custom_ref__";

export function ProjectEnvironmentConfiguration({
  testIdPrefix,
  translate,
  canManage,
  saving,
  workspacePolicy,
  onWorkspacePolicyChange,
  repositories,
  setupSteps,
  repositoryOptions,
  repositoriesByUrl,
  repositoriesLoadFailed,
  branchesByRepository,
  loadRepositoryOptions,
  loadBranches,
  selectRepository,
  updateRepository,
  updateRepositoryUrl,
  removeRepository,
  addRepository,
  addSetupStep,
  removeSetupStep,
  updateSetupStep,
  configurationError,
  configurationSaved,
  configurationDirty,
  saveConfiguration,
}: Props) {
  const [showAdvancedRepositories, setShowAdvancedRepositories] =
    useState(false);
  return (
    <div className="space-y-5 pt-2">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {translate("todo.execution_environment_repositories", "代码仓库")}
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-text-muted">
              {translate("common.optional", "可选")}
            </span>
          </h3>
          {canManage ? (
            <button
              className="collaboration-link-button"
              data-testid={`${testIdPrefix}-add-repository`}
              disabled={saving}
              type="button"
              onClick={addRepository}
            >
              ＋ {translate("todo.add_repository", "添加仓库")}
            </button>
          ) : null}
        </div>
        {repositories.length > 0 ? (
          <p className="mt-1 text-xs text-text-muted">
            {translate(
              "todo.execution_environment_repositories_description",
              "添加仓库后，主仓库是智能体默认工作目录；不添加则创建空白工作目录。",
            )}
          </p>
        ) : null}
        {repositories.length > 0 ? (
          <button
            className="collaboration-link-button mt-2"
            data-testid={`${testIdPrefix}-advanced-repositories`}
            aria-expanded={showAdvancedRepositories}
            type="button"
            onClick={() => setShowAdvancedRepositories((current) => !current)}
          >
            {showAdvancedRepositories
              ? translate("todo.hide_advanced_options", "收起高级选项")
              : translate("todo.show_advanced_options", "高级选项")}
          </button>
        ) : null}
        {repositories.length > 0 && repositoriesLoadFailed ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {translate(
              "todo.repositories_load_failed",
              "仓库列表加载失败，可直接填写仓库地址。",
            )}{" "}
            <button
              className="collaboration-link-button"
              data-testid={`${testIdPrefix}-repositories-retry`}
              type="button"
              onClick={() => void loadRepositoryOptions()}
            >
              {translate("common.retry", "重试")}
            </button>
          </p>
        ) : null}

        <div className="mt-3 space-y-3">
          {repositories.length === 0 ? (
            <p
              className="text-xs text-text-muted"
              data-testid={`${testIdPrefix}-repositories-empty`}
            >
              {translate(
                "todo.execution_environment_no_repositories",
                "未添加代码仓库，将使用空白工作目录。",
              )}
            </p>
          ) : null}
          {repositories.map((repository, index) => {
            const matchedOption = repositoriesByUrl.get(repository.url);
            const branchState = matchedOption
              ? branchesByRepository[repositoryKey(matchedOption)]
              : undefined;
            const branchOptions =
              branchState?.status === "ready" ? branchState.branches : [];
            const branchesReady = branchState?.status === "ready";
            const branchesFailed = branchState?.status === "error";
            const knownRef = branchOptions.some(
              (branch) => branch.name === repository.ref,
            );
            const repositorySelectValue = matchedOption
              ? repositoryKey(matchedOption)
              : repository.url
                ? CUSTOM_REPOSITORY_VALUE
                : "";
            const refSelectValue = knownRef
              ? repository.ref
              : repository.ref
                ? CUSTOM_REF_VALUE
                : "";
            return (
              <div
                className="rounded-lg border border-border p-4"
                data-testid={`${testIdPrefix}-repository-${index}`}
                key={repository.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      checked={repository.primary}
                      disabled={!canManage || saving}
                      name={`${testIdPrefix}-primary-repository`}
                      type="radio"
                      onChange={() =>
                        updateRepository(repository.id, { primary: true })
                      }
                    />
                    {repository.primary
                      ? translate(
                          "todo.execution_environment_primary_repository",
                          "主仓库",
                        )
                      : translate(
                          "todo.execution_environment_dependency_repository",
                          "依赖仓库",
                        )}
                  </label>
                  {canManage ? (
                    <button
                      className="text-sm text-text-secondary hover:text-text-primary"
                      data-testid={`${testIdPrefix}-remove-repository-${index}`}
                      disabled={saving}
                      type="button"
                      onClick={() => removeRepository(repository.id)}
                    >
                      {translate("common.remove", "移除")}
                    </button>
                  ) : null}
                </div>
                <div
                  className={`mt-3 grid gap-3 md:grid-cols-2 ${showAdvancedRepositories ? "" : "hidden"}`}
                >
                  <label className="text-sm">
                    <span className="mb-1 block">
                      {translate("todo.repository_name", "名称")}
                    </span>
                    <input
                      className="h-9 w-full rounded-lg border border-border bg-background px-3"
                      data-testid={`${testIdPrefix}-repository-name-${index}`}
                      disabled={!canManage || saving}
                      placeholder="Wegent"
                      value={repository.name}
                      onChange={(event) =>
                        updateRepository(repository.id, {
                          name: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block">
                      {translate("todo.repository_path", "目录")}
                    </span>
                    <input
                      className="h-9 w-full rounded-lg border border-border bg-background px-3"
                      data-testid={`${testIdPrefix}-repository-path-${index}`}
                      disabled={!canManage || saving}
                      placeholder={
                        repository.primary ? "wegent" : "deps/internal-sdk"
                      }
                      value={repository.path}
                      onChange={(event) =>
                        updateRepository(repository.id, {
                          path: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div
                  className={`mt-3 grid gap-3 ${showAdvancedRepositories ? "md:grid-cols-[minmax(0,1fr)_180px]" : ""}`}
                >
                  <label className="text-sm">
                    <span className="mb-1 block">
                      {translate("todo.repository_url", "Git 仓库")}
                    </span>
                    {repositoryOptions != null &&
                    repositoryOptions.length > 0 ? (
                      <select
                        className="h-9 w-full rounded-lg border border-border bg-background px-3"
                        data-testid={`${testIdPrefix}-repository-url-${index}`}
                        disabled={!canManage || saving}
                        value={repositorySelectValue}
                        onChange={(event) => {
                          if (event.target.value !== CUSTOM_REPOSITORY_VALUE) {
                            selectRepository(repository.id, event.target.value);
                          }
                        }}
                      >
                        <option disabled value="">
                          {translate(
                            "todo.repository_select_placeholder",
                            "选择仓库",
                          )}
                        </option>
                        {repository.url && !matchedOption ? (
                          <option value={CUSTOM_REPOSITORY_VALUE}>
                            {repository.url}
                          </option>
                        ) : null}
                        {repositoryOptions.map((option) => (
                          <option
                            key={repositoryKey(option)}
                            value={repositoryKey(option)}
                          >
                            {option.fullName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="h-9 w-full rounded-lg border border-border bg-background px-3"
                        data-testid={`${testIdPrefix}-repository-url-${index}`}
                        disabled={!canManage || saving}
                        placeholder="https://github.com/org/repository.git"
                        value={repository.url}
                        onChange={(event) =>
                          updateRepositoryUrl(repository.id, event.target.value)
                        }
                      />
                    )}
                  </label>
                  <label
                    className={`text-sm ${showAdvancedRepositories ? "" : "hidden"}`}
                  >
                    <span className="mb-1 block">
                      {translate(
                        "todo.execution_environment_repository_ref",
                        "分支或 Tag",
                      )}
                    </span>
                    {matchedOption && !branchesFailed ? (
                      <select
                        className="h-9 w-full rounded-lg border border-border bg-background px-3"
                        data-testid={`${testIdPrefix}-repository-ref-${index}`}
                        disabled={!canManage || saving || !branchesReady}
                        value={refSelectValue}
                        onChange={(event) => {
                          if (event.target.value !== CUSTOM_REF_VALUE) {
                            updateRepository(repository.id, {
                              ref: event.target.value,
                            });
                          }
                        }}
                      >
                        <option disabled value="">
                          {branchesReady
                            ? translate(
                                "todo.repository_ref_placeholder",
                                "选择分支或 Tag",
                              )
                            : translate("common.loading", "加载中…")}
                        </option>
                        {repository.ref && !knownRef ? (
                          <option value={CUSTOM_REF_VALUE}>
                            {repository.ref}
                          </option>
                        ) : null}
                        {branchOptions.map((branch) => (
                          <option key={branch.name} value={branch.name}>
                            {branch.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="h-9 w-full rounded-lg border border-border bg-background px-3"
                        data-testid={`${testIdPrefix}-repository-ref-${index}`}
                        disabled={!canManage || saving}
                        placeholder="main"
                        value={repository.ref}
                        onChange={(event) =>
                          updateRepository(repository.id, {
                            ref: event.target.value,
                          })
                        }
                      />
                    )}
                    {matchedOption && branchesFailed ? (
                      <p className="mt-1 text-xs text-destructive" role="alert">
                        {translate(
                          "todo.repository_branches_load_failed",
                          "分支加载失败，可手动填写。",
                        )}{" "}
                        <button
                          className="collaboration-link-button"
                          data-testid={`${testIdPrefix}-repository-ref-retry-${index}`}
                          type="button"
                          onClick={() => void loadBranches(matchedOption)}
                        >
                          {translate("common.retry", "重试")}
                        </button>
                      </p>
                    ) : null}
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">
            {translate("todo.execution_environment_setup", "初始化步骤")}
          </h3>
          {canManage ? (
            <button
              className="collaboration-link-button"
              data-testid={`${testIdPrefix}-add-setup-step`}
              disabled={saving}
              type="button"
              onClick={addSetupStep}
            >
              ＋ {translate("todo.add_setup_step", "添加步骤")}
            </button>
          ) : null}
        </div>
        {setupSteps.length > 0 ? (
          <p className="mt-1 text-xs text-text-muted">
            {translate(
              repositories.length > 0
                ? "todo.execution_environment_setup_description"
                : "todo.execution_environment_setup_without_repository_description",
              repositories.length > 0
                ? "步骤按顺序执行；工作目录为空时在主仓库执行，也可以指定任一仓库目录。"
                : "步骤按顺序在空白环境中执行；工作目录为空时使用环境根目录。",
            )}
          </p>
        ) : null}
        <div className="mt-3 space-y-2">
          {setupSteps.map((step, index) => (
            <div
              className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_auto]"
              data-testid={`${testIdPrefix}-setup-step-${index}`}
              key={step.id}
            >
              <input
                className="h-9 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                data-testid={`${testIdPrefix}-setup-command-${index}`}
                disabled={!canManage || saving}
                placeholder="pnpm install"
                value={step.command}
                onChange={(event) =>
                  updateSetupStep(step.id, {
                    command: event.target.value,
                  })
                }
              />
              <input
                className="h-9 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                data-testid={`${testIdPrefix}-setup-directory-${index}`}
                disabled={!canManage || saving}
                placeholder={translate(
                  "todo.execution_environment_setup_directory",
                  "工作目录（留空使用默认目录）",
                )}
                value={step.working_directory}
                onChange={(event) =>
                  updateSetupStep(step.id, {
                    working_directory: event.target.value,
                  })
                }
              />
              {canManage ? (
                <button
                  className="px-2 text-sm text-text-secondary hover:text-text-primary"
                  disabled={saving}
                  type="button"
                  data-testid={`${testIdPrefix}-remove-setup-step-${index}`}
                  onClick={() => removeSetupStep(step.id)}
                >
                  {translate("common.remove", "移除")}
                </button>
              ) : null}
            </div>
          ))}
          {setupSteps.length === 0 ? (
            <p className="text-xs text-text-muted">
              {translate(
                repositories.length > 0
                  ? "todo.no_setup_steps"
                  : "todo.no_setup_steps_without_repository",
                repositories.length > 0
                  ? "没有初始化步骤，仓库克隆完成后即可使用。"
                  : "没有初始化步骤，空白工作目录创建后即可使用。",
              )}
            </p>
          ) : null}
        </div>
      </div>

      <label className="mt-5 block text-sm">
        {translate("todo.workspace_policy", "任务工作区")}
        <select
          className="mt-2 block w-full rounded-md border border-border bg-background px-3 py-2"
          data-testid={`${testIdPrefix}-workspace-policy`}
          value={workspacePolicy}
          disabled={!canManage || saving}
          onChange={(event) => {
            onWorkspacePolicyChange(
              event.target.value as "git_worktree" | "project",
            );
          }}
        >
          <option value="git_worktree">
            {translate("todo.workspace_policy_isolated", "独立工作树（推荐）")}
          </option>
          <option value="project">
            {translate("todo.workspace_policy_shared", "共享项目目录")}
          </option>
        </select>
        <span className="mt-2 block text-xs text-text-muted">
          {translate(
            "todo.workspace_policy_description",
            "Git 仓库的新任务默认使用独立工作树；无仓库时使用环境目录。共享目录中的并行任务可能相互覆盖。修改仅影响新任务，无需重新初始化环境。",
          )}
        </span>
      </label>

      {canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
          {configurationError ? (
            <p
              className="mr-auto text-sm text-destructive"
              data-testid={`${testIdPrefix}-configuration-error`}
              role="alert"
            >
              {configurationError}
            </p>
          ) : configurationSaved ? (
            <span
              className="mr-auto text-sm text-[rgb(var(--color-success))]"
              data-testid={`${testIdPrefix}-configuration-status`}
              role="status"
            >
              {translate(
                "todo.execution_environment_configuration_saved",
                "配置已保存",
              )}
            </span>
          ) : configurationDirty ? (
            <span className="mr-auto text-sm text-text-muted">
              {translate(
                "todo.execution_environment_configuration_unsaved",
                "配置有未保存的修改",
              )}
            </span>
          ) : null}
          <button
            className="collaboration-primary-button"
            data-testid={`${testIdPrefix}-save-configuration`}
            disabled={saving || !configurationDirty}
            type="button"
            onClick={() => void saveConfiguration()}
          >
            {translate(
              "todo.execution_environment_save_configuration",
              "保存配置",
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
