import type { ComponentPropsWithRef } from "react";
import { isImeComposingEvent } from "@wegent/chat-core/ime";

/** Keep native form submission without treating IME selection as confirmation. */
export function DialogForm({
  onKeyDown,
  onSubmit,
  ...props
}: ComponentPropsWithRef<"form">) {
  return (
    <form
      {...props}
      onSubmit={(event) => {
        if (event.target === event.currentTarget) onSubmit?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          (isImeComposingEvent(event) ||
            event.repeat ||
            event.shiftKey ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.target.closest('[role="dialog"]') !==
              event.currentTarget.closest('[role="dialog"]'))
        )
          event.preventDefault();
      }}
    />
  );
}
