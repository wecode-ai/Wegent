import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  parsePluginMentionReference,
  type PluginReference,
} from "@wegent/chat-core/plugin-reference";
import {
  composerSkillFilePath,
  composerPathReference,
  createComposerMentionElement,
  type ComposerMentionPayload,
  type ComposerMentionIconResolver,
} from "./composerMentions";
import { parseComposerReference } from "./composerReference";

export class ComposerMentionNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly onOpenFile?: (path: string) => void;
  private readonly onOpenPlugin?: (reference: PluginReference) => void;
  private readonly onActivateMention?: (reference: string) => boolean;
  private readonly onOpenReference?: (href: string, label: string) => void;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    onOpenFile?: (path: string) => void,
    onOpenPlugin?: (reference: PluginReference) => void,
    resolveIcon?: ComposerMentionIconResolver,
    onActivateMention?: (reference: string) => boolean,
    onOpenReference?: (href: string, label: string) => void,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.onOpenFile = onOpenFile;
    this.onOpenPlugin = onOpenPlugin;
    this.onActivateMention = onActivateMention;
    this.onOpenReference = onOpenReference;
    this.dom = createComposerMentionElement(
      node.attrs as ComposerMentionPayload,
      resolveIcon,
    );
    if (this.hasOpenableReference()) {
      this.dom.setAttribute("role", "link");
      this.dom.setAttribute("tabindex", "0");
      this.dom.setAttribute("aria-disabled", "false");
      this.dom.setAttribute("data-composer-reference-navigation", "true");
      if (this.conversationHref()) {
        this.dom.setAttribute("data-composer-conversation-reference", "true");
      }
      if (this.issueHref()) {
        this.dom.setAttribute("data-composer-issue-reference", "true");
      }
    } else if (this.isAssignableMention() && onActivateMention) {
      this.dom.setAttribute("role", "button");
      this.dom.setAttribute("tabindex", "0");
    }
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.dom.addEventListener("click", this.handleClick);
    this.dom.addEventListener("keydown", this.handleKeyDown);
  }

  update(node: ProseMirrorNode): boolean {
    if (!node.sameMarkup(this.node)) return false;
    this.node = node;
    return true;
  }

  stopEvent(event: Event): boolean {
    return (
      event.type === "mousedown" ||
      event.type === "click" ||
      event.type === "keydown"
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.dom.removeEventListener("click", this.handleClick);
    this.dom.removeEventListener("keydown", this.handleKeyDown);
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    if (this.openFileMention()) return;
    if (this.hasOpenableReference()) return;
    if (this.pluginReference() && this.onOpenPlugin) return;
    if (this.isAssignableMention() && this.onActivateMention) return;

    const position = this.getPos();
    if (position === undefined) return;
    const bounds = this.dom.getBoundingClientRect();
    const nextPosition =
      event.clientX < bounds.left + bounds.width / 2
        ? position
        : position + this.node.nodeSize;
    this.view.dispatch(
      this.view.state.tr.setSelection(
        TextSelection.create(this.view.state.doc, nextPosition),
      ),
    );
    this.view.focus();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (
      !this.openReferenceMention() &&
      !this.activateMention() &&
      !this.openPluginMention()
    )
      return;

    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (
      !this.openReferenceMention() &&
      !this.activateMention() &&
      !this.openPluginMention()
    )
      return;

    event.preventDefault();
    event.stopPropagation();
  };

  private openFileMention(): boolean {
    const reference = String(this.node.attrs.reference ?? "");
    const filePath =
      composerSkillFilePath(reference) ??
      composerPathReference(reference)?.path;
    if (filePath && this.onOpenFile) {
      this.onOpenFile(filePath);
      return true;
    }
    return false;
  }

  private pluginReference(): PluginReference | null {
    return parsePluginMentionReference(String(this.node.attrs.reference ?? ""));
  }

  private referenceHref(): string | null {
    return (
      parseComposerReference(String(this.node.attrs.reference ?? ""))?.href ??
      null
    );
  }

  private conversationHref(): string | null {
    const href = this.referenceHref();
    return href?.startsWith("wework-conversation://") ? href : null;
  }

  private issueHref(): string | null {
    const href = this.referenceHref();
    return href?.startsWith("wework-issue://") ? href : null;
  }

  private openableReferenceHref(): string | null {
    return this.conversationHref() ?? this.issueHref();
  }

  private hasOpenableReference(): boolean {
    return Boolean(this.openableReferenceHref() && this.onOpenReference);
  }

  private openReferenceMention(): boolean {
    const href = this.openableReferenceHref();
    if (!href || !this.onOpenReference) return false;
    this.onOpenReference(href, String(this.node.attrs.label ?? ""));
    return true;
  }

  private isAssignableMention(): boolean {
    const kind = this.dom.getAttribute("data-composer-reference-kind");
    return kind === "member" || kind === "agent";
  }

  private activateMention(): boolean {
    return this.isAssignableMention()
      ? (this.onActivateMention?.(String(this.node.attrs.reference ?? "")) ??
          false)
      : false;
  }

  private openPluginMention(): boolean {
    const pluginReference = this.pluginReference();
    if (pluginReference && this.onOpenPlugin) {
      this.onOpenPlugin(pluginReference);
      return true;
    }

    return false;
  }
}
