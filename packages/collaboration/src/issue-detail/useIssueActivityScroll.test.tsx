// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectChatMessage } from "@wegent/chat-core";
import { useIssueActivityScroll } from "./useIssueActivityScroll";

const message = (id: string, status = "streaming"): ProjectChatMessage =>
  ({
    messageId: id,
    projectId: "project",
    taskId: "issue",
    sequenceNumber: id === "root" ? 1 : 2,
    rootMessageId: id === "root" ? null : "root",
    content: id,
    sender: {
      type: id === "root" ? "user" : "agent",
      id: "sender",
      name: "Sender",
    },
    metadata: {},
    status,
    createdAt: "",
    updatedAt: "",
  }) as ProjectChatMessage;

describe.each(["cloud-task-activity-card-", "collaboration-chat-card-"])(
  "%s shared scrolling",
  (prefix) => {
    let root: Root;
    let container: HTMLDivElement;
    let controls: ReturnType<typeof useIssueActivityScroll>;
    let frame: FrameRequestCallback | undefined;
    let scrollTo: ReturnType<typeof vi.fn>;
    let cardBottom: number;
    function Fixture({
      messages,
      issueId,
      readSequence,
      unread,
      onReadSequence,
    }: {
      messages: ProjectChatMessage[];
      issueId?: string;
      readSequence?: number;
      unread?: boolean;
      onReadSequence?: (sequence: number) => Promise<void> | void;
    }) {
      controls = useIssueActivityScroll({
        messages,
        loading: false,
        issueId,
        readSequence,
        unread,
        onReadSequence,
        cardTestIdPrefix: prefix,
      });
      return (
        <div ref={controls.listRef} data-testid="list">
          <div
            data-testid={`${prefix}root`}
            data-activity-sequence={Math.max(
              ...messages.map((item) => item.sequenceNumber),
            )}
          />
        </div>
      );
    }
    async function render(
      messages = [message("root"), message("run")],
      props: {
        issueId?: string;
        readSequence?: number;
        unread?: boolean;
        onReadSequence?: (sequence: number) => Promise<void> | void;
      } = {},
    ) {
      await act(async () =>
        root.render(<Fixture messages={messages} {...props} />),
      );
    }
    beforeEach(async () => {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frame = callback;
          return 1;
        },
      );
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
        frame = undefined;
      });
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await render();
      const list = container.querySelector<HTMLElement>(
        '[data-testid="list"]',
      )!;
      const card = list.firstElementChild as HTMLElement;
      Object.defineProperty(list, "scrollHeight", {
        configurable: true,
        value: 900,
      });
      cardBottom = 600;
      scrollTo = vi.fn();
      list.scrollTo = scrollTo;
      list.getBoundingClientRect = () =>
        ({ top: 0, bottom: 400, height: 400 }) as DOMRect;
      card.getBoundingClientRect = () =>
        ({ top: cardBottom - 100, bottom: cardBottom, height: 100 }) as DOMRect;
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    });
    it("does not move the list for incoming activity without a local submission", async () => {
      await render([message("root"), message("run"), message("another")]);
      act(() => frame?.(0));
      expect(scrollTo).not.toHaveBeenCalled();
    });
    it("reveals only the submitted card and relinquishes follow when the user scrolls away", async () => {
      act(() => controls.followCard("root"));
      await render();
      act(() => frame?.(0));
      expect(scrollTo).toHaveBeenCalledWith({ top: 212, behavior: "auto" });
      scrollTo.mockClear();
      act(() =>
        container
          .querySelector('[data-testid="list"]')!
          .dispatchEvent(new Event("scroll")),
      );
      await render();
      act(() => frame?.(0));
      expect(scrollTo).not.toHaveBeenCalled();
    });
    it("stops following after the final response and keeps top-level submit at the bottom", async () => {
      act(() => controls.followCard("root"));
      await render([message("root"), message("run", "completed")]);
      act(() => frame?.(0));
      scrollTo.mockClear();
      cardBottom = 800;
      await render([
        message("root"),
        message("run", "completed"),
        message("another"),
      ]);
      act(() => frame?.(0));
      expect(scrollTo).not.toHaveBeenCalled();
      act(() => controls.scrollTaskCommentsToBottom());
      expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
    });
    it("opens at the first unread activity and advances the cursor after it is visible", async () => {
      const onReadSequence = vi.fn();
      cardBottom = 200;
      vi.mocked(window.requestAnimationFrame).mockClear();
      await render([message("root"), message("run")], {
        issueId: "issue",
        readSequence: 1,
        onReadSequence,
      });
      const initialFrames = vi
        .mocked(window.requestAnimationFrame)
        .mock.calls.map(([callback]) => callback);
      act(() => initialFrames.forEach((callback) => callback(0)));
      expect(
        container.querySelector<HTMLElement>('[data-testid="list"]')!.scrollTop,
      ).toBe(100);
      act(() => frame?.(0));
      expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(2);
    });
    it("keeps the initial read baseline when new activity arrives", async () => {
      const onReadSequence = vi.fn();
      cardBottom = 200;
      vi.mocked(window.requestAnimationFrame).mockClear();
      await render([message("root")], {
        issueId: "issue",
        unread: false,
        onReadSequence,
      });
      act(() =>
        vi
          .mocked(window.requestAnimationFrame)
          .mock.calls.forEach(([callback]) => callback(0)),
      );
      expect(onReadSequence).not.toHaveBeenCalled();

      vi.mocked(window.requestAnimationFrame).mockClear();
      await render([message("root"), message("run")], {
        issueId: "issue",
        unread: false,
        onReadSequence,
      });
      act(() =>
        vi
          .mocked(window.requestAnimationFrame)
          .mock.calls.forEach(([callback]) => callback(0)),
      );
      expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(2);
    });
    it("allows the reader to retry the same sequence after a failed read request", async () => {
      const onReadSequence = vi
        .fn()
        .mockRejectedValueOnce(new Error("Read update failed"))
        .mockResolvedValue(undefined);
      cardBottom = 200;
      vi.mocked(window.requestAnimationFrame).mockClear();
      await render([message("root"), message("run")], {
        issueId: "issue",
        readSequence: 1,
        onReadSequence,
      });
      await act(async () =>
        vi
          .mocked(window.requestAnimationFrame)
          .mock.calls.forEach(([callback]) => callback(0)),
      );
      expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(2);

      await act(async () => {
        container
          .querySelector('[data-testid="list"]')!
          .dispatchEvent(new Event("scroll"));
        frame?.(0);
      });
      expect(onReadSequence.mock.calls).toEqual([[2], [2]]);
    });
  },
);

describe("visible Issue read state", () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let viewportHeight: number;
  let positions: Map<number, number>;
  const messages = [message("root"), message("run")];
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height }) as DOMRect;

  function Fixture({
    items = messages,
    loading = false,
    issueId = "issue",
    readSequence = 0,
    unreadRevision,
    onReadSequence,
  }: {
    items?: ProjectChatMessage[];
    loading?: boolean;
    issueId?: string;
    readSequence?: number;
    unreadRevision?: number;
    onReadSequence: (sequence: number) => Promise<void> | void;
  }) {
    const { listRef } = useIssueActivityScroll({
      messages: items,
      loading,
      issueId,
      readSequence,
      unreadRevision,
      onReadSequence,
      cardTestIdPrefix: "card-",
    });
    return (
      <div
        ref={(element) => {
          listRef.current = element;
          if (element) element.scrollTo = () => {};
        }}
        data-testid="list"
      >
        {!loading &&
          items.map((item) => (
            <div
              key={item.messageId}
              data-activity-sequence={item.sequenceNumber}
            />
          ))}
      </div>
    );
  }

  async function flushFrames() {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    frames = new Map();
    nextFrame = 0;
    viewportHeight = 400;
    positions = new Map([
      [1, 50],
      [2, 600],
    ]);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const sequence = Number(this.dataset.activitySequence);
        return sequence
          ? rect(positions.get(sequence) ?? 600, 100)
          : rect(0, viewportHeight);
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("persists an empty unread Issue only after loading and avoids duplicate requests", async () => {
    const onReadSequence = vi.fn().mockResolvedValue(undefined);
    const props = { items: [], unreadRevision: 1, onReadSequence };
    await act(async () => root.render(<Fixture {...props} loading />));
    await flushFrames();
    expect(onReadSequence).not.toHaveBeenCalled();
    await act(async () => root.render(<Fixture {...props} />));
    await flushFrames();
    expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(0);
    act(() => container.firstElementChild!.dispatchEvent(new Event("scroll")));
    await flushFrames();
    expect(onReadSequence).toHaveBeenCalledOnce();
  });

  it("keeps hidden empty Issues unread", async () => {
    viewportHeight = 0;
    const onReadSequence = vi.fn();
    await act(async () =>
      root.render(
        <Fixture
          items={[]}
          unreadRevision={1}
          onReadSequence={onReadSequence}
        />,
      ),
    );
    await flushFrames();
    expect(onReadSequence).not.toHaveBeenCalled();
  });

  it("reads visible activity and leaves offscreen replies unread until scrolling", async () => {
    const onReadSequence = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(<Fixture onReadSequence={onReadSequence} />),
    );
    await flushFrames();
    expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(1);
    positions.set(2, 200);
    act(() => container.firstElementChild!.dispatchEvent(new Event("scroll")));
    await flushFrames();
    expect(onReadSequence).toHaveBeenLastCalledWith(2);
  });

  it("retries a failed read when activity becomes visible again", async () => {
    const onReadSequence = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    await act(async () =>
      root.render(<Fixture onReadSequence={onReadSequence} />),
    );
    await flushFrames();
    act(() => container.firstElementChild!.dispatchEvent(new Event("scroll")));
    await flushFrames();
    expect(onReadSequence).toHaveBeenNthCalledWith(1, 1);
    expect(onReadSequence).toHaveBeenNthCalledWith(2, 1);
  });

  it("reads a visible incoming message without a scroll event", async () => {
    const onReadSequence = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Fixture
          items={[messages[0]!]}
          readSequence={1}
          onReadSequence={onReadSequence}
        />,
      ),
    );
    await flushFrames();
    expect(onReadSequence).not.toHaveBeenCalled();
    positions.set(2, 200);
    await act(async () =>
      root.render(<Fixture readSequence={1} onReadSequence={onReadSequence} />),
    );
    await flushFrames();
    expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("reads changed Issue content even when its activity cursor has not advanced", async () => {
    const onReadSequence = vi.fn().mockResolvedValue(undefined);
    for (const unreadRevision of [2, 3]) {
      await act(async () =>
        root.render(
          <Fixture
            readSequence={1}
            unreadRevision={unreadRevision}
            onReadSequence={onReadSequence}
          />,
        ),
      );
      await flushFrames();
    }
    expect(onReadSequence.mock.calls).toEqual([[1], [1]]);
  });

  it("deduplicates pending reads and isolates a new Issue from a late read response", async () => {
    let finishFirst!: () => void;
    const firstRead = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const secondRead = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<Fixture onReadSequence={firstRead} />));
    await flushFrames();
    act(() => container.firstElementChild!.dispatchEvent(new Event("scroll")));
    await flushFrames();
    expect(firstRead).toHaveBeenCalledExactlyOnceWith(1);

    await act(async () =>
      root.render(<Fixture issueId="other" onReadSequence={secondRead} />),
    );
    await flushFrames();
    expect(secondRead).toHaveBeenCalledExactlyOnceWith(1);
    await act(async () => finishFirst());
    act(() => container.firstElementChild!.dispatchEvent(new Event("scroll")));
    await flushFrames();
    expect(secondRead).toHaveBeenCalledOnce();
  });
});
