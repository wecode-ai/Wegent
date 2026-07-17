---
sidebar_position: 39
---

# Browser Annotation Reliability

## Background

Wework browser annotations use an injected page script to select target elements, edit comments, and convert published annotations into workspace comment context. The script currently listens for clicks on `document` during the capture phase. When the user clicks Publish inside the annotation editor, the capture listener runs before the button listener and incorrectly reopens an editor for the previously selected page element. This can make publishing appear unresponsive or create duplicate editors.

## Design

Annotation controls and page selection must use mutually exclusive event paths:

- When a click originates inside the annotation layer, the document-level selection listener returns immediately without reading the previous page element or creating an editor.
- Only clicks on page elements suppress the page's original interaction and open an annotation editor.
- Each editor owns its selection box reference. Publishing and cancellation operate only on that editor's box so a later interaction cannot overwrite a shared draft reference.
- Clicking Publish and pressing Enter outside an IME composition use the same publish function.

## Verification

Regression tests must execute the real annotation injection script and DOM events instead of only mocking an already-published result. They cover:

1. Selecting a page element opens exactly one editor.
2. Clicking Publish creates one annotation, closes the editor, and preserves the numbered selection box.
3. Clicking Publish does not select a page element again or create a second editor.
4. Enter publishing behaves the same as clicking Publish.
5. Consecutive annotations keep comments, numbers, and selection boxes correctly paired.

## Scope

This fix does not change the annotation data shape, workspace comment format, or backend APIs. It only corrects event isolation and draft lifecycle behavior in the injected page script.
