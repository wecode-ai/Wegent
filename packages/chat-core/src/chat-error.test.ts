// @vitest-environment node

import { describe, expect, test } from "vitest";
import { parseChatError } from "./chat-error";

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
    ["model_unavailable", "llm_error"],
    ["server_overloaded", "server_overloaded"],
    ["serverOverloaded", "server_overloaded"],
  ])(
    "uses backend error type %s before keyword matching",
    (errorType, normalizedType) => {
      expect(parseChatError("raw backend message", errorType).type).toBe(
        normalizedType,
      );
    },
  );

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
    ["unknown error", "generic_error"],
  ])("distinguishes %s", (message, expected) => {
    expect(parseChatError(message).type).toBe(expected);
  });

  test("keeps explicit terminal error types ahead of message heuristics", () => {
    expect(parseChatError("connection reset", "server_overloaded").type).toBe(
      "server_overloaded",
    );
  });
});
