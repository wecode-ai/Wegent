// @vitest-environment node

import { describe, expect, test } from "vitest";
import { parseChatError, type ChatErrorInfo } from "./chat-error";

describe("parseChatError", () => {
  test("uses executor Git diagnostics instead of classifying them as model errors", () => {
    const failure = {
      code: "credentials-required",
      domain: "git.example:8443",
      message: "Configure Git",
    };
    const parsed = parseChatError(
      `Checkout failed: git-access:${JSON.stringify(failure)}`,
      "container_error",
    );
    expect(parsed.gitFailure).toEqual(failure);
    expect(parsed.descriptionKey).toBe(
      "assistant_error.git_access.credentials-required",
    );
  });

  test.each([
    ["context_length_exceeded", "context_length_exceeded"],
    ["quota_exceeded", "quota_exceeded"],
    ["rate_limit", "rate_limit"],
    ["content_filter", "content_filter"],
    ["permission_denied", "permission_denied"],
    ["model_unavailable", "model_unavailable"],
    ["server_overloaded", "server_overloaded"],
    ["serverOverloaded", "server_overloaded"],
    ["device_callback_too_large", "payload_too_large"],
  ])(
    "uses backend error type %s before keyword matching",
    (errorType, normalizedType) => {
      expect(parseChatError("raw backend message", errorType).type).toBe(
        normalizedType,
      );
    },
  );

  test.each([
    ["server_overloaded", "model", "after_backoff"],
    ["authentication_expired", "access", "after_change"],
    ["skills_unmanaged_entries", "runtime", "after_change"],
    ["skill_deploy_failed", "runtime", "after_change"],
    ["executor_start_failed", "runtime", "unknown"],
    ["workspace_unavailable", "runtime", "after_change"],
    ["tool_execution_failed", "tool", "unknown"],
    ["connector_unavailable", "tool", "after_backoff"],
    ["plugin_load_failed", "tool", "after_change"],
    ["stream_protocol_error", "transport", "after_backoff"],
    ["internal_error", "platform", "after_backoff"],
    ["storage_error", "platform", "after_backoff"],
    ["dispatch_error", "platform", "after_backoff"],
  ])(
    "exposes the P0 classification and guidance keys for %s",
    (type, category, retryPolicy) => {
      const parsed = parseChatError("raw backend details", type);
      expect(parsed).toMatchObject({
        type,
        category,
        retryPolicy,
        titleKey: `assistant_error.types.${type}.title`,
        descriptionKey: `assistant_error.types.${type}.description`,
      });
    },
  );

  test.each([undefined, "generic_error", "unknown_backend_code"])(
    "refines the Skills directory conflict with backend type %s",
    (backendType) => {
      expect(
        parseChatError(
          "Agent Skills directory contains unmanaged entries",
          backendType,
        ),
      ).toMatchObject({
        type: "skills_unmanaged_entries",
        category: "runtime",
        retryPolicy: "after_change",
        descriptionKey:
          "assistant_error.types.skills_unmanaged_entries.description",
      });
    },
  );

  test("uses a structured cause when the enclosing backend error is generic", () => {
    expect(
      parseChatError(
        'Execution failed: {"error_code":"executor_start_failed","message":"start failed"}',
        "generic_error",
      ).type,
    ).toBe("executor_start_failed");
  });

  test("uses the canonical structured cause ahead of a weak LLM wrapper", () => {
    expect(
      parseChatError("Opaque error", "llm_error", {
        code: "skills_unmanaged_entries",
        retry_policy: "after_change",
      }),
    ).toMatchObject({
      type: "skills_unmanaged_entries",
      category: "runtime",
      retryPolicy: "after_change",
    });
  });

  test("uses validated backend retry policy without prescribing automatic retry", () => {
    expect(
      parseChatError("Tool failed", undefined, {
        retry_policy: "none",
      }).retryPolicy,
    ).toBe("none");
    expect(
      parseChatError("Tool failed", "tool_execution_failed", {
        retry_policy: "invalid",
      } as unknown as ChatErrorInfo).retryPolicy,
    ).toBe("unknown");
  });

  test("extracts backend error codes from JSON-shaped messages", () => {
    const parsed = parseChatError(
      'Task failed: {"error_code":"payload_too_large","message":"too much data"}',
    );

    expect(parsed.type).toBe("payload_too_large");
    expect(parsed.titleKey).toBe(
      "assistant_error.types.payload_too_large.title",
    );
  });

  test("distinguishes a proxy connection failure from the enclosing gateway status", () => {
    const parsed = parseChatError(
      'unexpected status 502 Bad Gateway: {"detail":"Local model proxy request failed: error sending request for url (https://model-gateway.example.internal/api/runtime-work/llm-responses-proxy/responses)"}',
    );

    expect(parsed.type).toBe("model_service_connection_error");
  });

  test.each([
    [
      'unexpected status 400 Bad Request: {"error":{"type":"invalid_request_error","message":"No tool output found for tool call call_1."}}',
      "invalid_message_history",
    ],
    [
      "Failed to deserialize the JSON body into the target type: input[3].content: invalid type",
      "invalid_message_history",
    ],
    [
      "Invalid 'input[0].id': 'fc_old'. Expected an ID that begins with 'ctc'.",
      "invalid_message_history",
    ],
    [
      "Failed to deserialize the JSON body into the target type: temperature: invalid type",
      "model_unavailable",
    ],
    ["504 Gateway Timeout", "timeout_error"],
  ])("classifies a model request failure by its cause", (error, type) => {
    expect(parseChatError(error, "llm_error").type).toBe(type);
  });

  test.each([
    ["model_unavailable", "invalid_message_history"],
    ["provider_error", "invalid_message_history"],
    ["timeout_error", "timeout_error"],
  ])("handles history diagnostics inside structured %s", (code, type) => {
    const error = "No tool output found for tool call call_1.";
    expect(parseChatError(error, "llm_error", { code }).type).toBe(type);
  });

  test.each([180, 30])(
    "classifies the %ss progress watchdog without blaming the provider",
    (seconds) => {
      const parsed = parseChatError(
        `codex app-server turn made no model or tool progress for ${seconds}s; the shared app-server was restarted`,
      );
      expect(parsed.type).toBe("timeout_error");
      expect(parsed.timeoutSeconds).toBe(seconds);
      expect(parsed.descriptionKey).toBe(
        "assistant_error.types.timeout_error.description_with_seconds",
      );
    },
  );

  test.each([
    [
      '{"error":{"codexErrorInfo":"serverOverloaded","message":"connection interrupted"}}',
      "server_overloaded",
    ],
    ["model is overloaded", "server_overloaded"],
    ["504 Gateway Timeout", "timeout_error"],
    ["502 Bad Gateway", "provider_error"],
    ["503 Service Unavailable", "provider_error"],
    ["connection reset", "network_error"],
    ["Executor failed: quota exceeded", "quota_exceeded"],
    ["Container request timed out", "timeout_error"],
    ["Executor failed: connection reset", "network_error"],
    ["Executor start failed", "executor_start_failed"],
    ["Executor not logged in", "authentication_expired"],
    ["Internal server error from executor", "internal_error"],
    ["unknown error", "generic_error"],
    ["constructor", "generic_error"],
  ])("distinguishes %s", (message, expected) => {
    expect(parseChatError(message).type).toBe(expected);
  });

  test("keeps explicit terminal error types ahead of message heuristics", () => {
    expect(parseChatError("connection reset", "server_overloaded").type).toBe(
      "server_overloaded",
    );
  });

  test("keeps canonical model unavailability ahead of message heuristics", () => {
    expect(
      parseChatError("executor request failed", "model_unavailable"),
    ).toMatchObject({
      type: "model_unavailable",
      category: "model",
      retryPolicy: "after_backoff",
    });
    expect(parseChatError("connection reset", "model_unavailable").type).toBe(
      "model_unavailable",
    );
  });

  test("lets a specific backend type outrank generic metadata", () => {
    expect(
      parseChatError("opaque failure", "model_service_connection_error", {
        code: "generic_error",
      }),
    ).toMatchObject({
      type: "model_service_connection_error",
      category: "transport",
    });
  });

  test("does not reuse metadata retry policy for a replacement cause", () => {
    expect(
      parseChatError("quota exceeded", "generic_error", {
        code: "generic_error",
        retry_policy: "unknown",
      }),
    ).toMatchObject({
      type: "quota_exceeded",
      retryPolicy: "after_change",
    });
  });

  test.each([
    [
      "Executor out of memory while handling a network request",
      "container_oom",
    ],
    ["connector not connected", "connector_unavailable"],
    ["executor request timed out", "timeout_error"],
    ["connection reset", "network_error"],
  ])(
    "keeps specific causes ahead of broad wrappers: %s",
    (message, expected) => {
      expect(parseChatError(message).type).toBe(expected);
    },
  );

  test("ignores unknown backend codes without reading object prototype entries", () => {
    expect(parseChatError("unknown error", "constructor").type).toBe(
      "generic_error",
    );
  });
});
