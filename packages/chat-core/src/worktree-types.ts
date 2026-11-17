import type { RuntimeWorktreeCapability } from "./execution-project";

export interface RuntimeWorktreeCapabilitiesRequest {
  deviceId: string;
}

export interface RuntimeWorktreeCapabilitiesResponse {
  success: boolean;
  deviceId: string;
  runtimeWorktrees: RuntimeWorktreeCapability | null;
}

export interface RuntimeWorktreePreflightRequest {
  deviceId: string;
  sourcePath: string;
  ref?: string | null;
  includeBranches?: boolean;
}

export interface RuntimeWorktreePreflightResponse {
  success: boolean;
  deviceId: string;
  supported: boolean;
  sourcePath: string;
  sourceExists: boolean;
  sourceDirectory: boolean;
  gitRepository: boolean;
  gitCommonDirValid: boolean;
  gitCommonDirWritable: boolean;
  writable: boolean;
  repoRoot?: string | null;
  gitCommonDir?: string | null;
  repoRootFingerprint?: string | null;
  gitRef?: string | null;
  currentBranch?: string | null;
  branches?: string[];
  refValid?: boolean | null;
  resolvedWorktreeRoot?: string | null;
  errorCode?: string | null;
  error?: string | null;
}
