import { useState, type RefObject } from "react";
import type { ComposerEditorHandle } from "./ComposerProseMirrorEditor";
import {
  serializeComposerLink,
  type ComposerLinkPayload,
} from "./composerLinks";

export function useComposerLinkEditing(
  editorRef: RefObject<ComposerEditorHandle | null>,
  commitEditorValue: (value: string, cursor: number) => void,
) {
  const [editingLink, setEditingLink] = useState<ComposerLinkPayload | null>(
    null,
  );
  const [editingLinkRange, setEditingLinkRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [editingLinkAnchor, setEditingLinkAnchor] =
    useState<HTMLElement | null>(null);
  const editComposerLink = (
    payload: ComposerLinkPayload,
    anchor?: HTMLElement,
    range?: { start: number; end: number },
  ) => {
    setEditingLink(payload);
    setEditingLinkRange(range ?? null);
    setEditingLinkAnchor(anchor ?? null);
  };
  const closeComposerLink = () => {
    setEditingLink(null);
    setEditingLinkRange(null);
    setEditingLinkAnchor(null);
  };
  const changeComposerLink = (next: { url: string; label: string }) => {
    const editor = editorRef.current;
    if (!editor || !editingLink || !editingLinkRange) return;
    const snapshot = editor.getSnapshot();
    const nextMarkdown = serializeComposerLink({ ...editingLink, ...next });
    const nextValue =
      snapshot.value.slice(0, editingLinkRange.start) +
      nextMarkdown +
      snapshot.value.slice(editingLinkRange.end);
    commitEditorValue(nextValue, editingLinkRange.start + nextMarkdown.length);
    closeComposerLink();
  };
  const removeComposerLink = () => {
    const editor = editorRef.current;
    if (!editor || !editingLinkRange) return;
    const snapshot = editor.getSnapshot();
    const before = snapshot.value.slice(0, editingLinkRange.start);
    const after = snapshot.value.slice(editingLinkRange.end);
    let nextValue = before + after;
    let cursor = before.length;
    if (before.endsWith(" ") && after.startsWith(" ")) {
      nextValue = before.slice(0, -1) + after;
      cursor = before.length - 1;
    }
    commitEditorValue(nextValue, Math.min(snapshot.selectionOffset, cursor));
    closeComposerLink();
  };
  return {
    editingLink,
    editingLinkAnchor,
    editComposerLink,
    closeComposerLink,
    changeComposerLink,
    removeComposerLink,
  };
}
