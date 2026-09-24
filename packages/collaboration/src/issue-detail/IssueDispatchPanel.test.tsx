// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IssueDispatch,
  SharedWorkspaceDispatchesApi,
} from "../ports/IssueDispatch";
import { useIssueDispatchController } from "./IssueDispatchPanel";

const dispatch: IssueDispatch = {
  id: "dispatch-1",
  projectId: "project-1",
  issueId: "issue-1",
  target: { kind: "collaboration_group", id: "group-1", name: "诊断小组" },
  leaderName: "诊断负责人",
  status: "active",
  managerTurnCount: 2,
  rounds: [
    {
      id: "round-1",
      dispatchId: "dispatch-1",
      sequence: 1,
      status: "evaluating",
      createdAt: "2026-09-24T01:00:00Z",
      completedAt: null,
      tasks: [
        {
          id: "task-1",
          dispatchId: "dispatch-1",
          roundId: "round-1",
          issueId: "issue-1",
          title: "采集 CPU 证据",
          instruction: "采集两次数据并返回证据。",
          target: { kind: "agent", id: "agent-1", name: "设备智能体" },
          workflowStageId: null,
          workflowStageName: null,
          executionLocation: "local",
          status: "running",
          outcome: null,
          createdAt: "2026-09-24T01:01:00Z",
          updatedAt: "2026-09-24T01:01:00Z",
        },
      ],
    },
  ],
  createdAt: "2026-09-24T01:00:00Z",
  updatedAt: "2026-09-24T01:01:00Z",
  completedAt: null,
};

function Harness({
  api,
  desktop = false,
}: {
  api: SharedWorkspaceDispatchesApi;
  desktop?: boolean;
}) {
  const controller = useIssueDispatchController({
    api,
    issueId: "issue-1",
    desktop,
    translate: (_key, fallback, options) =>
      Object.entries(options ?? {}).reduce(
        (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
        fallback ?? _key,
      ),
  });
  return (
    <>
      {controller.tools}
      {controller.activity}
      <span data-testid="issue-dispatch-activity-count">
        {controller.activityCount}
      </span>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function createApi(
  overrides: Partial<SharedWorkspaceDispatchesApi> = {},
): SharedWorkspaceDispatchesApi {
  return {
    list: vi.fn().mockResolvedValue([dispatch]),
    get: vi.fn().mockResolvedValue(dispatch),
    listCandidates: vi
      .fn()
      .mockResolvedValue([
        { kind: "agent", id: "agent-1", name: "设备智能体" },
      ]),
    create: vi.fn().mockResolvedValue(dispatch),
    createRound: vi.fn().mockResolvedValue(dispatch),
    cancelTask: vi.fn().mockResolvedValue({ ...dispatch, status: "cancelled" }),
    retry: vi.fn().mockResolvedValue(dispatch),
    decide: vi.fn().mockResolvedValue(dispatch),
    returnForRework: vi.fn().mockResolvedValue(dispatch),
    ...overrides,
  };
}

describe("Issue Dispatch activity", () => {
  it("does not refetch when the host recreates the API object", async () => {
    const list = vi.fn().mockResolvedValue([dispatch]);
    const stableMethods = createApi({ list });

    await act(async () => {
      root.render(<Harness api={{ ...stableMethods }} />);
    });
    await act(async () => {
      root.render(<Harness api={{ ...stableMethods }} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness api={{ ...stableMethods }} />);
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("issue-1");
  });

  it("shows the delegated task title, leader assignment and agent identity", async () => {
    await act(async () => root.render(<Harness api={createApi()} />));

    const task = container.querySelector<HTMLElement>(
      '[data-testid="issue-dispatch-task-task-1"]',
    );
    expect(task?.textContent).toContain("采集 CPU 证据");
    expect(task?.textContent).not.toContain("Issue title");
    expect(task?.dataset.state).toBe("running");
    expect(task?.dataset.executionLocation).toBe("local");
    expect(
      task
        ?.querySelector('[data-testid="issue-dispatch-assignee-avatar"]')
        ?.getAttribute("title"),
    ).toBe("设备智能体");
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-round-event-task-1"]',
      )?.textContent,
    ).toContain("诊断负责人（负责人）将「采集 CPU 证据」分配给 设备智能体");
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-round-event-task-1"] .task-detail-thread-message',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-leader-action-required"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-manager-turn-count"]',
      )?.textContent,
    ).toBe("2");
  });

  it("counts a pending human leader action before the first round", async () => {
    const pendingLeaderDispatch: IssueDispatch = {
      ...dispatch,
      leaderType: "human",
      leaderId: "human-1",
      managerTurnCount: 0,
      rounds: [],
    };

    await act(async () =>
      root.render(
        <Harness
          api={createApi({
            list: vi.fn().mockResolvedValue([pendingLeaderDispatch]),
          })}
        />,
      ),
    );

    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-leader-action-required"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-activity-count"]',
      )?.textContent,
    ).toBe("1");
  });

  it("renders the dispatch dialog even when the activity feed is empty", async () => {
    await act(async () =>
      root.render(
        <Harness
          api={createApi({
            list: vi.fn().mockResolvedValue([]),
          })}
        />,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="issue-dispatch-open"]')
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="issue-dispatch-dialog"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-activity-count"]',
      )?.textContent,
    ).toBe("1");
  });

  it("cancels immediately on web and confirms cancellation on desktop", async () => {
    const webApi = createApi();
    await act(async () => root.render(<Harness api={webApi} />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-dispatch-task-cancel"]',
        )
        ?.click();
    });
    expect(webApi.cancelTask).toHaveBeenCalledWith("task-1");

    await act(async () => root.render(<Harness api={createApi()} desktop />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-dispatch-task-cancel"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="issue-dispatch-cancel-dialog"]'),
    ).not.toBeNull();
  });

  it("uses host-specific candidate and submit controls", async () => {
    const api = createApi();
    await act(async () => root.render(<Harness api={api} desktop />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="issue-dispatch-open"]')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="issue-dispatch-dialog"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="issue-dispatch-task-instructions"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="issue-dispatch-submit"]'),
    ).not.toBeNull();
  });

  it("enables a mixed agent and human round after every task is complete", async () => {
    const api = createApi({
      listCandidates: vi.fn().mockImplementation((_issueId, targetType) =>
        Promise.resolve(
          targetType === "agent"
            ? [{ kind: "agent", id: "agent-1", name: "设备智能体" }]
            : [{ kind: "human", id: "human-1", name: "项目成员" }],
        ),
      ),
    });
    await act(async () => root.render(<Harness api={api} desktop />));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-dispatch-round-open"]',
        )
        ?.click();
      await Promise.resolve();
    });

    const fill = async (selector: string, value: string) => {
      const element = container.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(selector);
      expect(element).not.toBeNull();
      await act(async () => {
        const prototype =
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          element,
          value,
        );
        element?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await fill(
      '[data-testid="issue-dispatch-round-task-0"] [data-testid="issue-dispatch-round-task-title"]',
      "采集诊断证据",
    );
    await fill(
      '[data-testid="issue-dispatch-round-task-0"] [data-testid="issue-dispatch-round-task-instructions"]',
      "提交可复核的诊断证据。",
    );
    await act(async () => {
      const agent = container.querySelector<HTMLButtonElement>(
        '[data-testid="issue-dispatch-round-task-0"] [data-testid="issue-dispatch-round-assignee-agent-agent-1"]',
      );
      expect(agent).not.toBeNull();
      agent?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-dispatch-round-add-task"]',
        )
        ?.click();
    });
    await fill(
      '[data-testid="issue-dispatch-round-task-1"] [data-testid="issue-dispatch-round-task-title"]',
      "复核诊断结论",
    );
    await fill(
      '[data-testid="issue-dispatch-round-task-1"] [data-testid="issue-dispatch-round-task-instructions"]',
      "提交独立复核结论。",
    );
    await act(async () => {
      const human = container.querySelector<HTMLButtonElement>(
        '[data-testid="issue-dispatch-round-task-1"] [data-testid="issue-dispatch-round-assignee-human-human-1"]',
      );
      expect(human).not.toBeNull();
      human?.click();
    });

    expect(
      Array.from(
        container.querySelectorAll<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >(
          '[data-testid^="issue-dispatch-round-task-"] input, [data-testid^="issue-dispatch-round-task-"] textarea, [data-testid^="issue-dispatch-round-task-"] select',
        ),
      ).map((element) => element.value),
    ).toEqual([
      "采集诊断证据",
      "提交可复核的诊断证据。",
      "agent:agent-1",
      "复核诊断结论",
      "提交独立复核结论。",
      "human:human-1",
    ]);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="issue-dispatch-round-submit"]',
      )?.disabled,
    ).toBe(false);
  });
});
