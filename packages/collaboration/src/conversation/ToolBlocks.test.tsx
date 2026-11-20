// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { ConversationTranslationProvider } from "./ConversationTranslation";
import { ToolBlockItem } from "./blocks/ToolBlockItem";
import { ToolBlocksDisplay } from "./blocks/ToolBlocksDisplay";
import { WebSearchSourcesChip } from "./blocks/WebSearchSources";
import type { ToolBlock } from "./blocks/types";
import { getBlockLabel } from "./blocks/toolBlockLabels";
import {
  MarkdownServicesProvider,
  browserMarkdownServices,
} from "../markdown/MarkdownServices";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(children: ReactNode) {
  act(() =>
    root.render(
      <ConversationTranslationProvider
        translate={createCollaborationTranslator("en")}
      >
        {children}
      </ConversationTranslationProvider>,
    ),
  );
}
function block(id: string): ToolBlock {
  return {
    id,
    subtaskId: 1,
    type: "tool",
    toolName: "bash",
    toolInput: { command: "pwd" },
    toolOutput: "/workspace",
    status: "done",
    createdAt: 1770000000000,
  };
}

describe("shared tool output without a desktop host", () => {
  it.each([false, true])(
    "expands one provider catalog on demand (legacy response: %s)",
    (legacy) => {
      const catalog = {
        items: [
          {
            id: "github",
            availability: { status: "ready" },
            eventTypes: ["git.event"],
          },
          { id: "gitlab", availability: { status: "plugin_disabled" } },
        ],
      };
      render(
        <ToolBlockItem
          block={{
            ...block("event-providers"),
            toolName: "wework_control.list_connection_event_providers",
            toolInput: {},
            toolOutput: {
              content: legacy
                ? [{ type: "text", text: JSON.stringify(catalog) }]
                : [],
              structuredContent: legacy
                ? catalog
                : {
                    items: catalog.items.map(({ id, availability }) => ({
                      id,
                      availability,
                    })),
                  },
              _meta: legacy
                ? null
                : { connectionEventProviderCatalog: catalog },
            },
          }}
          forceExpanded
        />,
      );

      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="connection-event-provider-result-toggle"]',
      )!;
      const output = () =>
        container.querySelector('[data-testid="generic-tool-output"]');
      expect(container.textContent).toContain("2 total, 1 ready");
      expect(output()).toBeNull();
      act(() => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(JSON.parse(output()!.textContent!)).toEqual(catalog);
      act(() => toggle.click());
      expect(output()).toBeNull();
    },
  );

  it.each([
    ["done", "Ran pwd"],
    ["streaming", "Running pwd"],
    ["error", "Command failed: pwd"],
  ] as const)("localizes command labels for %s tools", (status, expected) => {
    const tool = { ...block("localized-command"), status };
    expect(getBlockLabel(tool, createCollaborationTranslator("en")).label).toBe(
      expected,
    );
    expect(
      getBlockLabel(tool, createCollaborationTranslator("zh-CN")).label,
    ).toMatch(/运行/);
  });

  it("localizes file reads and file fallbacks through the conversation catalog", () => {
    const translate = createCollaborationTranslator("en");
    const read = {
      ...block("localized-read"),
      toolInput: { command: "cat requirements.md" },
    };
    expect(getBlockLabel(read, translate).label).toBe("Read requirements.md");
    const create = {
      ...block("localized-create"),
      toolName: "create_file",
      toolInput: {},
    };
    expect(getBlockLabel(create, translate).label).toBe("Created file");
  });

  it.each(["done", "error", "pending"] as const)(
    "shows native AI review evidence for %s decisions",
    (status) => {
      render(
        <ToolBlocksDisplay
          blocks={[
            {
              ...block("review-1"),
              toolName: "auto_approval_review",
              status,
              toolOutput: JSON.stringify({
                rationale: "Check the authorized destination",
              }),
            },
          ]}
          isStreaming={status === "pending"}
          forceExpanded
        />,
      );
      expect(
        container.querySelector('[data-testid="auto-approval-review"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain(
        "Check the authorized destination",
      );
      expect(container.textContent).toContain(
        status === "done"
          ? "AI review approved"
          : status === "error"
            ? "Not executed: AI review denied or incomplete"
            : "AI is reviewing the action",
      );
    },
  );

  it.each([1, 2])("preserves count-aware summaries for %s tools", (count) => {
    render(
      <ToolBlocksDisplay
        blocks={Array.from({ length: count }, (_, index) =>
          block(`call-${index}`),
        )}
        isStreaming={false}
      />,
    );
    const summary = container.querySelector(
      '[data-testid="processing-summary-header"]',
    );
    expect(summary?.textContent).toContain(
      count === 1 ? "Called 1 tool" : "Called 2 tools",
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="processing-summary-toggle"]',
    )!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses the host URL service and shared locale for search sources", async () => {
    const openExternalUrl = vi.fn();
    render(
      <MarkdownServicesProvider
        value={{ ...browserMarkdownServices, openExternalUrl }}
      >
        <WebSearchSourcesChip
          sources={[
            {
              id: "source-1",
              label: "Reference",
              domain: "example.com",
              iconUrl: "https://example.com/favicon.ico",
              url: "https://example.com/docs",
            },
          ]}
        />
      </MarkdownServicesProvider>,
    );
    expect(
      container.querySelector('[data-testid="web-search-sources-chip"]')
        ?.textContent,
    ).toBe("Sources");
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="web-search-source-popup-row"]',
    )!;
    await act(async () => link.click());
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/docs",
    );
  });
  it("does not expose a working ignore button without a runtime handler", () => {
    const request: ToolBlock = {
      ...block("request-1"),
      toolName: "request_user_input",
      status: "pending",
      renderPayload: {
        kind: "request_user_input",
        requestId: 3,
        questions: [
          {
            id: "scope",
            question: "Which scope?",
            options: [{ label: "Project" }],
          },
        ],
      },
    };
    render(<ToolBlocksDisplay blocks={[request]} isStreaming forceExpanded />);
    const ignore = container.querySelector<HTMLButtonElement>(
      '[data-testid="request-user-input-ignore-button"]',
    );
    expect(ignore).not.toBeNull();
    expect(ignore?.disabled).toBe(true);
  });
  it("keeps an opened native approval rationale when the conversation remounts", () => {
    const review: ToolBlock = {
      ...block("review-retained-details"),
      toolName: "auto_approval_review",
      status: "error",
      toolOutput: { rationale: "Private data is outside the task" },
    };
    const show = () =>
      render(
        <ToolBlocksDisplay
          blocks={[review]}
          isStreaming={false}
          forceExpanded
        />,
      );
    show();
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-testid="auto-approval-review"]',
    )!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    render(<div>Other conversation</div>);
    show();
    expect(
      container.querySelector<HTMLDetailsElement>(
        '[data-testid="auto-approval-review"]',
      )?.open,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="auto-approval-review-evidence"]')
        ?.textContent,
    ).toContain("Private data is outside the task");
  });
});

describe("automatic retry presentation", () => {
  it.each([
    ["custom", "overload", "Server is busy, reconnecting…"],
    ["codex-official", "overload", "Server is busy, reconnecting…"],
    ["codex-official", "rate_limit", "Model rate limited. Waiting to retry…"],
    ["codex-official", "unknown", "Retrying automatically…"],
  ])("shows classified progress for %s / %s", (modelKind, reason, expected) => {
    const retry: ToolBlock = {
      ...block("classified-retry"),
      toolName: "runtime_reconnecting",
      status: "streaming",
      toolInput: {
        model_kind: modelKind,
        retry_reason: reason,
        retry_attempt: 2,
        retry_max_attempts: 5,
      },
    };
    render(
      <ToolBlocksDisplay
        blocks={[block("completed-command"), retry]}
        isStreaming
        forceExpanded
      />,
    );
    expect(
      container.querySelector('[data-testid="processing-summary-header"]')
        ?.textContent,
    ).toContain(expected + " (2/5)");
    expect(
      container.querySelector(
        '[data-testid="runtime-reconnecting-open-proxy-settings"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="assistant-error-card"]'),
    ).toBeNull();
    render(
      <ToolBlocksDisplay
        blocks={[block("completed-command"), { ...retry, status: "done" }]}
        isStreaming
        forceExpanded
      />,
    );
    expect(container.textContent).not.toContain("(2/5)");
  });
  it("uses native reconnect progress without showing the raw message", () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          block("completed-command"),
          {
            ...block("native-retry"),
            toolName: "runtime_reconnecting",
            status: "streaming",
            toolInput: {
              retry_reason: "connection",
              message: "Reconnecting... 3/5",
            },
          },
        ]}
        isStreaming
      />,
    );
    expect(
      container.querySelector('[data-testid="processing-summary-header"]')
        ?.textContent,
    ).toContain("Reconnecting… (3/5)");
    expect(container.textContent).not.toContain("Reconnecting... 3/5");
  });
  it("keeps overload progress through its countdown and clears it on completion", () => {
    vi.useFakeTimers();
    try {
      const retry: ToolBlock = {
        ...block("countdown-retry"),
        toolName: "runtime_reconnecting",
        status: "streaming",
        toolInput: {
          retry_reason: "overload",
          retry_at: Date.now() + 10_000,
          retry_attempt: 2,
          retry_max_attempts: 4,
          model_kind: "codex-official",
        },
      };
      render(<ToolBlockItem block={retry} />);
      const status = () =>
        container.querySelector('[data-testid="runtime-overload-wait-status"]');
      expect(status()?.textContent).toContain("10s");
      expect(status()?.textContent).toContain("(2/4)");
      expect(
        container.querySelector(
          '[data-testid="runtime-reconnecting-open-proxy-settings"]',
        ),
      ).toBeNull();
      act(() => vi.advanceTimersByTime(10_000));
      expect(status()?.textContent).toContain("Retrying the same model");
      expect(status()?.textContent).toContain("(2/4)");
      render(<ToolBlockItem block={{ ...retry, status: "done" }} />);
      expect(status()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
