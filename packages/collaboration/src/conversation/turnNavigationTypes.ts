import type { RefObject } from "react";
import type { WorkbenchMessage } from "@wegent/chat-core";
import type { RuntimeTurnNavigationItem } from "@wegent/chat-core/runtime";
import type { CollaborationTranslate } from "../i18n";

export type NavigationMessage = Pick<
  WorkbenchMessage,
  "id" | "role" | "content" | "blocks"
> & {
  turnId?: string | null;
  runtimeMessageIndex?: number | null;
};

export interface MessageTurnNavigationProps {
  translate: CollaborationTranslate;
  messages: NavigationMessage[];
  turnNavigation?: RuntimeTurnNavigationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onLoadTurnNavigationItem?: (
    item: RuntimeTurnNavigationItem,
  ) => Promise<void> | void;
  onNavigationLoadStateChange?: (loading: boolean) => void;
  onNavigationScrollTargetChange?: (messageId: string | null) => void;
  portalTarget?: Element | null;
}

export interface UserTurn {
  id: string;
  turnId?: string | null;
  turnIndex: number;
  messageIndex: number;
  promptPreview: string;
  responsePreview: string;
  cursor?: string | null;
  loaded: boolean;
}

export interface MessageTurnMarker extends UserTurn {
  targetTop: number | null;
  visibleTop: number | null;
  visibleBottom: number | null;
}

export interface PendingScrollTarget {
  navigationId: string;
  turnId?: string | null;
  messageIndex: number;
}

export interface TurnVisibilityBounds {
  top: number;
  bottom: number;
}

export interface MeasuredScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
}
