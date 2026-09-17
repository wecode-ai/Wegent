import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function IssueActivityContent({
  messageId,
  children,
  expandLabel,
  collapseLabel,
}: {
  messageId: string;
  children: ReactNode;
  expandLabel: string;
  collapseLabel: string;
}) {
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const collapsingRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const measure = () => {
      const limit = Number.parseFloat(
        getComputedStyle(root).getPropertyValue(
          "--task-activity-preview-height",
        ),
      );
      setOverflowing(content.getBoundingClientRect().height > limit + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(root);
    return () => observer.disconnect();
  }, [children]);

  useLayoutEffect(() => {
    if (!collapsingRef.current) return;
    collapsingRef.current = false;
    const article = rootRef.current?.closest("article");
    const scroller = article?.closest(".task-detail-left");
    if (
      article &&
      scroller &&
      article.getBoundingClientRect().top < scroller.getBoundingClientRect().top
    ) {
      article.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }, [expanded]);

  const collapsed = overflowing && !expanded;
  return (
    <div
      ref={rootRef}
      className="task-activity-content"
      data-testid={`task-activity-content-${messageId}`}
      data-expanded={expanded}
    >
      <div
        id={contentId}
        className={`task-activity-content-viewport${expanded ? " is-expanded" : ""}${collapsed ? " is-collapsed" : ""}`}
        onFocusCapture={(event) => {
          if (
            collapsed &&
            (event.currentTarget.scrollTop > 0 ||
              event.target.getBoundingClientRect().bottom >
                event.currentTarget.getBoundingClientRect().bottom)
          ) {
            event.currentTarget.scrollTop = 0;
            setExpanded(true);
          }
        }}
      >
        <div ref={contentRef} className="task-activity-content-body">
          {children}
        </div>
      </div>
      {overflowing ? (
        <button
          type="button"
          className="task-activity-content-toggle"
          data-testid={`task-activity-content-toggle-${messageId}`}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => {
            collapsingRef.current = expanded;
            setExpanded((value) => !value);
          }}
        >
          {expanded ? collapseLabel : expandLabel}
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      ) : null}
    </div>
  );
}
