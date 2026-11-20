import { parseGitAccessFailure, type GitAccessFailure } from "./git-access";
import type { ChatErrorInfo } from "./api-types";
export type { ChatErrorInfo } from "./api-types";

export type ChatErrorType =
  | "context_length_exceeded"
  | "quota_exceeded"
  | "rate_limit"
  | "payload_too_large"
  | "model_service_connection_error"
  | "network_error"
  | "timeout_error"
  | "server_overloaded"
  | "llm_error"
  | "model_unavailable"
  | "llm_unsupported"
  | "invalid_parameter"
  | "forbidden"
  | "container_oom"
  | "container_error"
  | "content_filter"
  | "provider_error"
  | "image_too_large"
  | "model_protocol_error"
  | "invalid_role"
  | "permission_denied"
  | "authentication_expired"
  | "skills_unmanaged_entries"
  | "skill_deploy_failed"
  | "executor_start_failed"
  | "workspace_unavailable"
  | "tool_execution_failed"
  | "connector_unavailable"
  | "plugin_load_failed"
  | "stream_protocol_error"
  | "internal_error"
  | "storage_error"
  | "dispatch_error"
  | "generic_error";

export type ChatErrorCategory =
  | "model"
  | "input"
  | "access"
  | "policy"
  | "runtime"
  | "tool"
  | "transport"
  | "platform"
  | "unknown";

export type ChatRetryPolicy =
  | "after_backoff"
  | "after_change"
  | "none"
  | "unknown";

export interface ParsedChatError {
  type: ChatErrorType;
  category: ChatErrorCategory;
  retryPolicy: ChatRetryPolicy;
  titleKey: string;
  descriptionKey: string;
  timeoutSeconds?: number;
  gitFailure?: GitAccessFailure;
}

const BACKEND_TYPE_MAP: Record<string, ChatErrorType> = {
  context_length_exceeded: "context_length_exceeded",
  quota_exceeded: "quota_exceeded",
  rate_limit: "rate_limit",
  llm_error: "model_unavailable",
  model_unavailable: "model_unavailable",
  container_oom: "container_oom",
  container_error: "container_error",
  model_service_connection_error: "model_service_connection_error",
  network_error: "network_error",
  timeout_error: "timeout_error",
  server_overloaded: "server_overloaded",
  serverOverloaded: "server_overloaded",
  rateLimitExceeded: "rate_limit",
  usageLimitExceeded: "quota_exceeded",
  contextWindowExceeded: "context_length_exceeded",
  unauthorized: "forbidden",
  llm_unsupported: "llm_unsupported",
  forbidden: "forbidden",
  payload_too_large: "payload_too_large",
  invalid_parameter: "invalid_parameter",
  content_filter: "content_filter",
  provider_error: "provider_error",
  image_too_large: "image_too_large",
  model_protocol_error: "model_protocol_error",
  invalid_role: "invalid_role",
  permission_denied: "permission_denied",
  authentication_expired: "authentication_expired",
  skills_unmanaged_entries: "skills_unmanaged_entries",
  skill_deploy_failed: "skill_deploy_failed",
  executor_start_failed: "executor_start_failed",
  workspace_unavailable: "workspace_unavailable",
  tool_execution_failed: "tool_execution_failed",
  connector_unavailable: "connector_unavailable",
  plugin_load_failed: "plugin_load_failed",
  stream_protocol_error: "stream_protocol_error",
  internal_error: "internal_error",
  storage_error: "storage_error",
  dispatch_error: "dispatch_error",
  generic_error: "generic_error",
};

const ERROR_METADATA: Record<
  ChatErrorType,
  { category: ChatErrorCategory; retryPolicy: ChatRetryPolicy }
> = {
  context_length_exceeded: { category: "input", retryPolicy: "after_change" },
  quota_exceeded: { category: "model", retryPolicy: "after_change" },
  rate_limit: { category: "model", retryPolicy: "after_backoff" },
  payload_too_large: { category: "input", retryPolicy: "after_change" },
  model_service_connection_error: {
    category: "transport",
    retryPolicy: "after_backoff",
  },
  network_error: { category: "transport", retryPolicy: "after_backoff" },
  timeout_error: { category: "transport", retryPolicy: "after_backoff" },
  server_overloaded: { category: "model", retryPolicy: "after_backoff" },
  llm_error: { category: "model", retryPolicy: "after_backoff" },
  model_unavailable: { category: "model", retryPolicy: "after_backoff" },
  llm_unsupported: { category: "input", retryPolicy: "after_change" },
  invalid_parameter: { category: "input", retryPolicy: "after_change" },
  forbidden: { category: "access", retryPolicy: "after_change" },
  container_oom: { category: "runtime", retryPolicy: "after_change" },
  container_error: { category: "runtime", retryPolicy: "after_change" },
  content_filter: { category: "policy", retryPolicy: "after_change" },
  provider_error: { category: "model", retryPolicy: "after_backoff" },
  image_too_large: { category: "input", retryPolicy: "after_change" },
  model_protocol_error: { category: "input", retryPolicy: "after_change" },
  invalid_role: { category: "input", retryPolicy: "after_change" },
  permission_denied: { category: "access", retryPolicy: "after_change" },
  authentication_expired: { category: "access", retryPolicy: "after_change" },
  skills_unmanaged_entries: {
    category: "runtime",
    retryPolicy: "after_change",
  },
  skill_deploy_failed: { category: "runtime", retryPolicy: "after_change" },
  executor_start_failed: { category: "runtime", retryPolicy: "unknown" },
  workspace_unavailable: { category: "runtime", retryPolicy: "after_change" },
  tool_execution_failed: { category: "tool", retryPolicy: "unknown" },
  connector_unavailable: { category: "tool", retryPolicy: "after_backoff" },
  plugin_load_failed: { category: "tool", retryPolicy: "after_change" },
  stream_protocol_error: {
    category: "transport",
    retryPolicy: "after_backoff",
  },
  internal_error: { category: "platform", retryPolicy: "after_backoff" },
  storage_error: { category: "platform", retryPolicy: "after_backoff" },
  dispatch_error: { category: "platform", retryPolicy: "after_backoff" },
  generic_error: { category: "unknown", retryPolicy: "unknown" },
};

const CLASSIFICATION_RULES: Array<[ChatErrorType, Array<string | RegExp>]> = [
  [
    "skills_unmanaged_entries",
    [
      "agent skills directory contains unmanaged entries",
      "skills_unmanaged_entries",
    ],
  ],
  [
    "context_length_exceeded",
    [
      "prompt is too long",
      "context_length_exceeded",
      "context length exceeded",
      "maximum context length",
      "max_tokens",
      "token limit exceeded",
      "tokens exceeds the model",
      "input is too long",
      "request too large",
      "maximum number of tokens",
    ],
  ],
  [
    "content_filter",
    [
      "data_inspection_failed",
      "inappropriate content",
      "content filter",
      "content management",
      "content_policy",
      "contentfilter",
      "risky content",
      "content_filtering_policy",
      "responsibleaipolicy",
      "resp_safety_modify_answer",
    ],
  ],
  [
    "image_too_large",
    ["image exceeds", "image too large", "image size exceeds"],
  ],
  ["invalid_role", ["invalid role"]],
  [
    "model_protocol_error",
    [
      "invalid model id",
      "only claude",
      "only thudm",
      "only moonshot",
      "anthropic protocol",
      "anthropic 协议",
      "不支持 anthropic",
    ],
  ],
  [
    "quota_exceeded",
    [
      "quota exceeded",
      "insufficient_quota",
      "billing",
      "credit balance",
      "payment required",
      "account balance",
      "insufficient funds",
      "exceeded your current quota",
    ],
  ],
  ["rate_limit", ["rate limit", "rate_limit", "too many requests", "throttl"]],
  [
    "server_overloaded",
    [
      "server is overloaded",
      "server overloaded",
      "server_overloaded",
      "server_is_overloaded",
      "model is overloaded",
      "overloaded",
    ],
  ],
  [
    "authentication_expired",
    [
      "authentication_expired",
      "authentication expired",
      "credentials expired",
      "not logged in",
    ],
  ],
  [
    "permission_denied",
    ["permission_denied", "permission denied", "permission_error"],
  ],
  ["forbidden", ["forbidden", "not allowed", "unauthorized", "403"]],
  // Specific causes remain informative inside provider or executor wrappers.
  [
    "container_oom",
    ["out of memory", /\boom\b/, "oom killed", "memory allocation"],
  ],
  ["timeout_error", ["timeout", "timed out", "504 gateway", "超时"]],
  [
    "connector_unavailable",
    [
      "connector_unavailable",
      "connector unavailable",
      "connector not connected",
    ],
  ],
  [
    "network_error",
    [
      "network",
      "fetch",
      "error sending request",
      "failed to send request",
      "connection refused",
      "connection reset",
      "connection error",
      "not connected",
      "websocket",
      "peer closed connection",
      "upstream connection interrupted",
    ],
  ],
  [
    "provider_error",
    [
      "error from provider",
      "upstream error",
      "502 bad gateway",
      "503 service unavailable",
    ],
  ],
  [
    "llm_unsupported",
    [
      "multi-modal",
      "multimodal",
      "do not support",
      "does not support",
      "not support image",
    ],
  ],
  [
    "model_unavailable",
    [
      "model not found",
      "model unavailable",
      "model_not_found",
      "model error",
      "llm request failed",
      "llm api error",
      "llm call failed",
      "llm service error",
    ],
  ],
  ["invalid_parameter", ["invalid parameter", "invalid_parameter"]],
  ["payload_too_large", ["413", "payload too large"]],
  [
    "skill_deploy_failed",
    [
      "skill_deploy_failed",
      "skill deployment failed",
      "failed to deploy skill",
    ],
  ],
  [
    "executor_start_failed",
    [
      "executor_start_failed",
      "executor start failed",
      "failed to start executor",
    ],
  ],
  [
    "workspace_unavailable",
    ["workspace_unavailable", "workspace unavailable", "workspace not found"],
  ],
  ["tool_execution_failed", ["tool_execution_failed", "tool execution failed"]],
  [
    "plugin_load_failed",
    ["plugin_load_failed", "plugin load failed", "failed to load plugin"],
  ],
  ["stream_protocol_error", ["stream_protocol_error", "stream protocol error"]],
  ["internal_error", ["internal_error", "internal server error"]],
  ["storage_error", ["storage_error", "storage error"]],
  ["dispatch_error", ["dispatch_error", "dispatch failed"]],
  [
    "container_error",
    [
      "container",
      "executor",
      "docker",
      "disappeared unexpectedly",
      "no ports mapped",
      "crashed unexpectedly",
      "exit code",
      "device disconnected",
    ],
  ],
];

export function parseChatError(
  error: string,
  backendType?: string | null,
  errorInfo?: ChatErrorInfo,
): ParsedChatError {
  const gitFailure = parseGitAccessFailure(error);
  if (gitFailure) {
    return {
      type: "generic_error",
      category: "access",
      retryPolicy: "after_change",
      titleKey: "assistant_error.git_access.title",
      descriptionKey: `assistant_error.git_access.${gitFailure.code}`,
      gitFailure,
    };
  }
  const metadataType = normalizeSpecificBackendType(errorInfo?.code);
  const backendTypeValue = normalizeSpecificBackendType(backendType);
  const explicitType = metadataType ?? backendTypeValue;
  if (explicitType) {
    const retryPolicy =
      metadataType !== undefined ? errorInfo?.retry_policy : undefined;
    return buildParsedChatError(explicitType, error, retryPolicy);
  }

  const structuredCode = extractStructuredErrorType(error);
  const structuredType = normalizeSpecificBackendType(structuredCode);
  if (structuredType) {
    return buildParsedChatError(structuredType, error);
  }

  const messageType = classifyByMessage(error);
  const hasLegacyWrapper =
    isLegacyLLMError(errorInfo?.code) ||
    isLegacyLLMError(backendType) ||
    isLegacyLLMError(structuredCode);
  const type =
    messageType !== "generic_error"
      ? messageType
      : hasLegacyWrapper
        ? "model_unavailable"
        : "generic_error";
  return buildParsedChatError(
    type,
    error,
    errorInfo?.code == null ? errorInfo?.retry_policy : undefined,
  );
}

function normalizeSpecificBackendType(
  type?: string | null,
): ChatErrorType | undefined {
  const normalizedType = normalizeBackendType(type);
  return normalizedType &&
    normalizedType !== "generic_error" &&
    !isLegacyLLMError(type)
    ? normalizedType
    : undefined;
}

function isLegacyLLMError(type?: string | null): boolean {
  return type?.trim().toLowerCase() === "llm_error";
}

function buildParsedChatError(
  type: ChatErrorType,
  error: string,
  retryPolicy?: ChatErrorInfo["retry_policy"],
): ParsedChatError {
  const metadata = ERROR_METADATA[type];
  const timeoutSeconds =
    type === "timeout_error"
      ? Number(
          error.match(
            /\bturn made no model or tool progress for (\d+)s\b/i,
          )?.[1],
        ) || undefined
      : undefined;

  return {
    type,
    category: metadata.category,
    retryPolicy: isRetryPolicy(retryPolicy)
      ? retryPolicy
      : metadata.retryPolicy,
    titleKey: `assistant_error.types.${type}.title`,
    descriptionKey: `assistant_error.types.${type}.${timeoutSeconds ? "description_with_seconds" : "description"}`,
    timeoutSeconds,
  };
}

function isRetryPolicy(policy: unknown): policy is ChatRetryPolicy {
  return ["after_backoff", "after_change", "none", "unknown"].includes(
    policy as string,
  );
}

function normalizeBackendType(type?: string | null): ChatErrorType | undefined {
  if (!type) return undefined;
  const normalized = type.trim();
  const key = Object.prototype.hasOwnProperty.call(BACKEND_TYPE_MAP, normalized)
    ? normalized
    : normalized.toLowerCase();
  return Object.prototype.hasOwnProperty.call(BACKEND_TYPE_MAP, key)
    ? BACKEND_TYPE_MAP[key]
    : undefined;
}

function classifyByMessage(message: string): ChatErrorType {
  const lowerMessage = message.toLowerCase();
  if (/\bturn made no model or tool progress for \d+s\b/.test(lowerMessage)) {
    return "timeout_error";
  }
  if (
    lowerMessage.includes("local model proxy request failed") &&
    (lowerMessage.includes("error sending request for url") ||
      lowerMessage.includes("failed to send request"))
  ) {
    return "model_service_connection_error";
  }

  for (const [type, patterns] of CLASSIFICATION_RULES) {
    if (
      patterns.some((pattern) =>
        typeof pattern === "string"
          ? lowerMessage.includes(pattern)
          : pattern.test(lowerMessage),
      )
    ) {
      return type;
    }
  }

  return "generic_error";
}

function extractStructuredErrorType(message: string): string | undefined {
  const candidates = extractJsonObjects(message);
  for (const candidate of candidates) {
    const type = findErrorType(candidate);
    if (type) return type;
  }

  return undefined;
}

function extractJsonObjects(message: string): unknown[] {
  const objects: unknown[] = [];
  const startIndexes: number[] = [];

  for (let index = 0; index < message.length; index += 1) {
    if (message[index] === "{") {
      startIndexes.push(index);
    }
  }

  for (const start of startIndexes) {
    const parsed = tryParseJsonSuffix(message.slice(start));
    if (parsed !== undefined) {
      objects.push(parsed);
    }
  }

  return objects;
}

function tryParseJsonSuffix(text: string): unknown {
  for (let end = text.length; end > 0; end -= 1) {
    const candidate = text.slice(0, end).trim();
    if (!candidate.endsWith("}")) continue;

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue trimming until the embedded JSON object boundary is found.
    }
  }

  return undefined;
}

function findErrorType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  for (const key of [
    "error_type",
    "error_code",
    "codexErrorInfo",
    "type",
    "code",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && normalizeBackendType(candidate)) {
      return candidate;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedType = findErrorType(nested);
    if (nestedType) return nestedType;
  }

  return undefined;
}
