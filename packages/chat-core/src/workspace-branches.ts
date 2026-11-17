import type {
  RuntimeWorktreePreflightRequest,
  RuntimeWorktreePreflightResponse,
} from "./worktree-types";

export type WorktreePreflightReader = (
  input: RuntimeWorktreePreflightRequest,
) => Promise<RuntimeWorktreePreflightResponse>;

export async function listWorkspaceBranches(
  preflight: WorktreePreflightReader,
  input: Pick<RuntimeWorktreePreflightRequest, "deviceId" | "sourcePath">,
): Promise<string[]> {
  const result = await preflight({ ...input, includeBranches: true });
  if (!result.success || !result.gitRepository)
    throw new Error(result.error || "Workspace is not a Git repository");
  if (
    !Array.isArray(result.branches) ||
    result.branches.some((branch) => typeof branch !== "string")
  ) {
    throw new Error(
      "Connected Executor does not support worktree branch inspection",
    );
  }
  const branches = [
    ...new Set(result.branches.map((branch) => branch.trim()).filter(Boolean)),
  ];
  const current = result.currentBranch?.trim() ?? "";
  return branches.includes(current)
    ? [current, ...branches.filter((branch) => branch !== current)]
    : branches;
}

export function branchMatchesQuery(branch: string, query: string): boolean {
  const normalizedBranch = branch.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || normalizedBranch.includes(normalizedQuery))
    return true;

  let queryIndex = 0;
  for (const character of normalizedBranch) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === normalizedQuery.length) return true;
    }
  }
  return false;
}
