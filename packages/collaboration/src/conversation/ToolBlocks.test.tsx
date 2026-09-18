// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { ConversationTranslationProvider } from "./ConversationTranslation";
import { ToolBlocksDisplay } from "./blocks/ToolBlocksDisplay";
import { WebSearchSourcesChip } from "./blocks/WebSearchSources";
import type { ToolBlock } from "./blocks/types";
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
});
