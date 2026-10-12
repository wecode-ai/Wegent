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
      onReadSequence,
    }: {
      messages: ProjectChatMessage[];
      issueId?: string;
      readSequence?: number;
      onReadSequence?: (sequence: number) => void;
    }) {
      controls = useIssueActivityScroll({
        messages,
        loading: false,
        issueId,
        readSequence,
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
        onReadSequence?: (sequence: number) => void;
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
      expect(scrollTo).toHaveBeenCalledWith({ top: 100, behavior: "auto" });
      act(() => frame?.(0));
      expect(onReadSequence).toHaveBeenCalledExactlyOnceWith(2);
    });
  },
);
