import {
  DEFAULT_UI_FONT_SIZE,
  resolveUiTypographyVariables,
} from '@/features/appearance/typography'

export interface BrowserAnnotationInjectionStrings {
  placeholder: string
  publish: string
  save: string
  cancel: string
  adjust: string
  delete: string
  deleteTitle: string
  deleteDescription: string
  targetUnavailable: string
  properties: Record<string, string>
}

export interface BrowserAnnotationInjectionOptions {
  browserTabId?: string
  uiFontSize?: number
  strings?: Partial<BrowserAnnotationInjectionStrings>
}

const defaultStrings: BrowserAnnotationInjectionStrings = {
  placeholder: 'Add a comment...',
  publish: 'Publish',
  save: 'Save',
  cancel: 'Cancel',
  adjust: 'Adjust',
  delete: 'Delete',
  deleteTitle: 'Delete this annotation?',
  deleteDescription: 'This annotation and its page adjustments will be removed.',
  targetUnavailable: 'The annotated element is no longer available.',
  properties: {},
}

export function browserAnnotationInjectionScript({
  browserTabId = 'workspace-browser',
  uiFontSize = DEFAULT_UI_FONT_SIZE,
  strings = {},
}: BrowserAnnotationInjectionOptions = {}) {
  const typography = resolveUiTypographyVariables(uiFontSize)
  const config = JSON.stringify({
    browserTabId,
    strings: { ...defaultStrings, ...strings, properties: strings.properties ?? {} },
  })

  return String.raw`
(() => {
  const config = ${config};
  const existing = window.__WEWORK_BROWSER_ANNOTATION__;
  if (existing?.scope?.browserTabId === config.browserTabId) {
    existing.resume?.();
    return true;
  }
  try { existing?.destroy?.(); } catch (_) {}

  const properties = ['text', 'color', 'background-color', 'opacity', 'font-family', 'font-size', 'font-weight', 'width', 'height', 'padding', 'margin', 'border-radius', 'border-color', 'border-width'];
  const pixelProperties = new Set(['font-size', 'width', 'height', 'padding', 'margin', 'border-radius', 'border-width']);
  const colorProperties = new Set(['color', 'background-color', 'border-color']);
  const pageSessionId = window.crypto?.randomUUID?.() || 'page-' + Date.now() + '-' + Math.random();
  const scope = { browserTabId: config.browserTabId, pageSessionId, url: window.location.href };
  const state = {
    annotations: [], nextNumber: 1, revision: 0, layer: null, hoverBox: null, hoverElement: null,
    activeEditor: null, activeInput: null, attached: false, animationFrame: null, resizeObserver: null,
    baselineByElement: new Map(),
  };

  const isLayerTarget = target => target instanceof Element && target.closest('[data-wework-annotation-layer]');
  const rectFor = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  const textFor = (element, maxLength = 500) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  const targetFor = element => ({ tagName: element.tagName.toLowerCase(), text: textFor(element), role: element.getAttribute('role') || undefined, name: textFor(element, 120), rect: rectFor(element) });
  const snapshot = () => ({ scope, revision: state.revision, annotations: state.annotations.map(annotation => ({ id: annotation.id, number: annotation.number, comment: annotation.comment, adjustments: annotation.adjustments, target: { ...annotation.target, rect: annotation.lastKnownRect }, createdAt: annotation.createdAt, updatedAt: annotation.updatedAt })) });
  const bumpRevision = () => { state.revision += 1; };
  const style = (node, values) => Object.assign(node.style, values);
  const makeBox = (rect, hover = false) => {
    const box = document.createElement('div');
    box.dataset.weworkAnnotation = hover ? 'hover' : 'box';
    style(box, { position: 'fixed', left: rect.x + 'px', top: rect.y + 'px', width: Math.max(1, rect.width) + 'px', height: Math.max(1, rect.height) + 'px', border: '2px solid #1683ff', background: hover ? 'rgba(147,197,253,.28)' : 'rgba(147,197,253,.45)', boxSizing: 'border-box', pointerEvents: 'none' });
    return box;
  };
  const positionBox = (box, rect) => style(box, { left: rect.x + 'px', top: rect.y + 'px', width: Math.max(1, rect.width) + 'px', height: Math.max(1, rect.height) + 'px' });
  const rememberBaseline = element => {
    if (!element || state.baselineByElement.has(element)) return;
    state.baselineByElement.set(element, { styleAttribute: element.getAttribute('style'), text: element.children.length === 0 && !element.isContentEditable ? element.textContent : undefined });
  };
  const simpleTextTarget = element => Boolean(element && element.children.length === 0 && !element.isContentEditable && !['INPUT', 'TEXTAREA'].includes(element.tagName));
  const restoreBaseline = element => {
    const baseline = state.baselineByElement.get(element);
    if (!baseline) return;
    if (baseline.styleAttribute === null) element.removeAttribute('style'); else element.setAttribute('style', baseline.styleAttribute);
    if (baseline.text !== undefined) element.textContent = baseline.text;
  };
  const applyAdjustment = (element, adjustment) => {
    if (!element?.isConnected) return;
    if (adjustment.property === 'text') { if (simpleTextTarget(element)) element.textContent = adjustment.after; return; }
    element.style.setProperty(adjustment.property, adjustment.after);
  };
  const replayElement = (element, draft = []) => {
    if (!element?.isConnected) return;
    restoreBaseline(element);
    state.annotations.filter(annotation => annotation.element === element).sort((a, b) => a.number - b.number).forEach(annotation => annotation.adjustments.forEach(adjustment => applyAdjustment(element, adjustment)));
    draft.forEach(adjustment => applyAdjustment(element, adjustment));
  };
  const restoreAll = () => state.baselineByElement.forEach((_, element) => restoreBaseline(element));
  const clearHover = () => { state.hoverBox?.remove(); state.hoverBox = null; state.hoverElement = null; };
  const closeEditor = () => { state.activeEditor?.remove(); state.activeEditor = null; state.activeInput = null; };
  const renderAnnotation = annotation => {
    annotation.box?.remove();
    const box = makeBox(annotation.lastKnownRect);
    const badge = document.createElement('button');
    badge.type = 'button'; badge.dataset.weworkAnnotation = 'badge'; badge.textContent = String(annotation.number); badge.setAttribute('aria-label', String(annotation.number));
    style(badge, { position: 'absolute', right: '4px', top: '4px', minWidth: '20px', height: '20px', padding: '0 4px', border: '0', borderRadius: '999px', background: '#1683ff', color: 'white', cursor: 'pointer', pointerEvents: 'auto', fontSize: ${JSON.stringify(typography['--text-xs'])}, fontWeight: '600' });
    badge.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); showEditor(annotation.element, annotation); });
    box.appendChild(badge); annotation.box = box; state.layer?.appendChild(box);
  };
  const schedulePositionUpdate = () => { if (state.animationFrame !== null) return; state.animationFrame = window.requestAnimationFrame(() => { state.animationFrame = null; state.annotations.forEach(annotation => { if (annotation.element?.isConnected) annotation.lastKnownRect = rectFor(annotation.element); if (annotation.box) positionBox(annotation.box, annotation.lastKnownRect); }); if (state.hoverBox && state.hoverElement?.isConnected) positionBox(state.hoverBox, rectFor(state.hoverElement)); }); };
  const normalize = (property, value) => {
    const raw = String(value).trim();
    if (!raw || /(?:calc|var|url)\(|\b(?:auto|inherit|initial|unset)\b/i.test(raw)) return null;
    if (property === 'text') return raw;
    if (colorProperties.has(property)) return !window.CSS?.supports || CSS.supports(property, raw) ? raw : null;
    if (property === 'opacity') { const number = Number(raw); return Number.isFinite(number) && number >= 0 && number <= 1 ? String(Math.round(number * 20) / 20) : null; }
    if (property === 'font-weight') return ['100','200','300','400','500','600','700','800','900'].includes(raw) ? raw : null;
    if (property === 'font-family') return raw.includes(';') ? null : raw;
    if (pixelProperties.has(property)) { const number = Number(raw.replace(/px$/i, '')); const allowsNegative = property === 'margin'; return Number.isFinite(number) && (allowsNegative || number >= 0) ? number + 'px' : null; }
    return null;
  };
  const currentValue = (element, property) => property === 'text' ? (element?.textContent || '') : element ? getComputedStyle(element).getPropertyValue(property).trim() : '';
  const editorButton = (text, testId, primary = false) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.dataset.weworkAnnotation = testId; style(button, { height: '28px', border: primary ? '0' : '1px solid rgba(0,0,0,.12)', borderRadius: '6px', padding: '0 8px', background: primary ? '#171717' : 'white', color: primary ? 'white' : '#171717', cursor: 'pointer', fontSize: ${JSON.stringify(typography['--text-xs'])} }); return button; };
  const openDeleteConfirmation = (annotation, close) => {
    const dialog = document.createElement('div'); dialog.dataset.weworkAnnotation = 'delete-confirmation'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    style(dialog, { position: 'fixed', zIndex: '1', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 'min(320px, calc(100vw - 16px))', padding: '16px', border: '1px solid rgba(0,0,0,.12)', borderRadius: '12px', background: 'white', boxShadow: '0 8px 16px rgba(0,0,0,.12)', boxSizing: 'border-box', pointerEvents: 'auto', fontSize: ${JSON.stringify(typography['--text-sm'])} });
    const title = document.createElement('strong'); title.textContent = config.strings.deleteTitle;
    const description = document.createElement('p'); description.textContent = config.strings.deleteDescription; style(description, { margin: '8px 0 16px', color: '#5d5d5d' });
    const actions = document.createElement('div'); style(actions, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancel = editorButton(config.strings.cancel, 'delete-cancel'); const remove = editorButton(config.strings.delete, 'delete-confirm', true); style(remove, { background: '#dc2626' });
    cancel.addEventListener('click', () => { dialog.remove(); state.activeInput?.focus(); });
    remove.addEventListener('click', () => { const element = annotation.element; state.annotations = state.annotations.filter(item => item.id !== annotation.id); annotation.box?.remove(); replayElement(element); bumpRevision(); dialog.remove(); close(); schedulePositionUpdate(); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel.click(); } });
    actions.append(cancel, remove); dialog.append(title, description, actions); state.layer?.appendChild(dialog); cancel.focus();
  };
  const showEditor = (element, annotation) => {
    closeEditor(); clearHover();
    const targetAvailable = Boolean(element?.isConnected);
    const rect = annotation?.lastKnownRect || (targetAvailable ? rectFor(element) : { x: 8, y: 8, width: 1, height: 1 });
    const editor = document.createElement('div'); editor.dataset.weworkAnnotation = 'editor';
    style(editor, { position: 'fixed', left: Math.min(Math.max(8, rect.x + 8), Math.max(8, window.innerWidth - 332)) + 'px', top: Math.min(Math.max(8, rect.y + 28), Math.max(8, window.innerHeight - 64)) + 'px', width: 'min(324px, calc(100vw - 16px))', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '8px', border: '1px solid rgba(0,0,0,.12)', background: 'white', boxShadow: '0 8px 16px rgba(0,0,0,.12)', boxSizing: 'border-box', pointerEvents: 'auto' });
    const input = document.createElement('input'); input.placeholder = config.strings.placeholder; input.value = annotation?.comment || ''; input.dataset.weworkAnnotation = 'comment-input'; style(input, { minWidth: '150px', flex: '1', height: '28px', border: '0', outline: '0', fontSize: ${JSON.stringify(typography['--text-base'])}, background: 'transparent' });
    const adjust = editorButton(config.strings.adjust, 'adjust-toggle'); const cancel = editorButton(config.strings.cancel, 'cancel'); const save = editorButton(annotation ? config.strings.save : config.strings.publish, 'save', true); const remove = annotation ? editorButton(config.strings.delete, 'delete') : null; if (remove) style(remove, { color: '#b91c1c' });
    const initialAdjustments = annotation ? annotation.adjustments.map(item => ({ ...item })) : [];
    let draftAdjustments = initialAdjustments.map(item => ({ ...item })); let adjustmentPanel = null;
    const restoreDraft = () => { if (element?.isConnected) replayElement(element); };
    const updateDraft = (property, raw) => { if (!targetAvailable) return; rememberBaseline(element); const existing = draftAdjustments.find(item => item.property === property); const after = normalize(property, raw); const before = existing?.before || currentValue(element, property); draftAdjustments = draftAdjustments.filter(item => item.property !== property); if (after && after !== before) draftAdjustments.push({ property, before, after }); save.disabled = !input.value.trim() && draftAdjustments.length === 0; replayElement(element, draftAdjustments); schedulePositionUpdate(); };
    const renderAdjustments = () => {
      adjustmentPanel?.remove(); adjustmentPanel = document.createElement('div'); adjustmentPanel.dataset.weworkAnnotation = 'adjustments'; style(adjustmentPanel, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', width: '100%', borderTop: '1px solid rgba(0,0,0,.08)', paddingTop: '8px' });
      if (!targetAvailable) { const note = document.createElement('p'); note.textContent = config.strings.targetUnavailable; style(note, { gridColumn: '1 / -1', margin: '0', color: '#5d5d5d' }); adjustmentPanel.appendChild(note); }
      properties.forEach(property => { const label = document.createElement('label'); label.textContent = config.strings.properties[property] || property; style(label, { display: 'flex', flexDirection: 'column', gap: '3px', color: '#414141', fontSize: ${JSON.stringify(typography['--text-xs'])} }); const field = document.createElement('input'); field.dataset.weworkAnnotation = 'adjustment-' + property; field.disabled = !targetAvailable || (property === 'text' && !simpleTextTarget(element)); field.value = draftAdjustments.find(item => item.property === property)?.after || (targetAvailable ? currentValue(element, property) : ''); field.type = property === 'opacity' || pixelProperties.has(property) ? 'number' : 'text'; if (property === 'opacity') { field.min = '0'; field.max = '1'; field.step = '.05'; } field.addEventListener('input', () => updateDraft(property, field.value)); style(field, { height: '26px', minWidth: '0', border: '1px solid rgba(0,0,0,.12)', borderRadius: '4px', padding: '0 6px', fontSize: ${JSON.stringify(typography['--text-xs'])}, boxSizing: 'border-box' }); label.appendChild(field); if (colorProperties.has(property)) { const picker = document.createElement('input'); picker.type = 'color'; picker.value = /^#[0-9a-f]{6}$/i.test(field.value) ? field.value : '#000000'; picker.disabled = field.disabled; picker.setAttribute('aria-label', label.textContent); picker.addEventListener('input', () => { field.value = picker.value; updateDraft(property, picker.value); }); style(picker, { height: '26px', width: '30px', padding: '0', border: '0', background: 'transparent' }); const row = document.createElement('div'); style(row, { display: 'flex', gap: '4px' }); row.append(field, picker); label.textContent = config.strings.properties[property] || property; label.appendChild(row); } adjustmentPanel.appendChild(label); });
      editor.insertBefore(adjustmentPanel, cancel);
    };
    adjust.addEventListener('click', () => { if (adjustmentPanel) { adjustmentPanel.remove(); adjustmentPanel = null; } else renderAdjustments(); });
    const persist = () => { const comment = input.value.trim(); if (!comment && draftAdjustments.length === 0) return; if (annotation) { annotation.comment = comment; annotation.adjustments = draftAdjustments; annotation.updatedAt = new Date().toISOString(); replayElement(element); } else { const target = targetFor(element); const next = { id: 'browser-annotation-' + Date.now() + '-' + state.nextNumber, number: state.nextNumber++, comment, adjustments: draftAdjustments, target, element, lastKnownRect: target.rect, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), box: null }; state.annotations.push(next); replayElement(element); renderAnnotation(next); } bumpRevision(); closeEditor(); schedulePositionUpdate(); };
    save.disabled = !input.value.trim() && draftAdjustments.length === 0; input.addEventListener('input', () => { save.disabled = !input.value.trim() && draftAdjustments.length === 0; });
    save.addEventListener('click', event => { event.preventDefault(); persist(); }); cancel.addEventListener('click', () => { restoreDraft(); closeEditor(); }); remove?.addEventListener('click', () => openDeleteConfirmation(annotation, () => closeEditor()));
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); persist(); } if (event.key === 'Escape') { event.preventDefault(); restoreDraft(); closeEditor(); } }); editor.addEventListener('pointerdown', event => event.stopPropagation()); editor.append(input, adjust, ...(remove ? [remove] : []), cancel, save); state.layer?.appendChild(editor); state.activeEditor = editor; state.activeInput = input; input.focus();
  };
  const validTarget = target => !(target instanceof Element) || isLayerTarget(target) || target === document.body || target === document.documentElement ? null : target;
  const onMouseMove = event => { if (state.activeEditor) return; const target = validTarget(event.target); if (!target) { clearHover(); return; } state.hoverElement = target; const rect = rectFor(target); if (!state.hoverBox) { state.hoverBox = makeBox(rect, true); state.layer?.appendChild(state.hoverBox); } else positionBox(state.hoverBox, rect); };
  const onClick = event => { if (state.activeEditor || isLayerTarget(event.target)) return; const target = validTarget(event.target); if (!target) return; event.preventDefault(); event.stopPropagation(); showEditor(target, null); };
  const attach = () => { if (state.attached) return; const layer = document.createElement('div'); layer.dataset.weworkAnnotationLayer = 'true'; style(layer, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none', userSelect: 'none' }); document.documentElement.appendChild(layer); state.layer = layer; state.attached = true; state.annotations.forEach(annotation => { if (annotation.element?.isConnected) replayElement(annotation.element); renderAnnotation(annotation); }); document.addEventListener('mousemove', onMouseMove, true); document.addEventListener('click', onClick, true); document.addEventListener('scroll', schedulePositionUpdate, true); window.addEventListener('resize', schedulePositionUpdate); window.visualViewport?.addEventListener('resize', schedulePositionUpdate); window.visualViewport?.addEventListener('scroll', schedulePositionUpdate); if (typeof ResizeObserver !== 'undefined') { state.resizeObserver = new ResizeObserver(schedulePositionUpdate); state.resizeObserver.observe(document.documentElement); state.annotations.forEach(annotation => annotation.element?.isConnected && state.resizeObserver.observe(annotation.element)); } schedulePositionUpdate(); };
  const detach = () => { if (!state.attached) return; closeEditor(); clearHover(); document.removeEventListener('mousemove', onMouseMove, true); document.removeEventListener('click', onClick, true); document.removeEventListener('scroll', schedulePositionUpdate, true); window.removeEventListener('resize', schedulePositionUpdate); window.visualViewport?.removeEventListener('resize', schedulePositionUpdate); window.visualViewport?.removeEventListener('scroll', schedulePositionUpdate); state.resizeObserver?.disconnect(); state.resizeObserver = null; if (state.animationFrame !== null) window.cancelAnimationFrame(state.animationFrame); state.animationFrame = null; state.layer?.remove(); state.layer = null; state.annotations.forEach(annotation => { annotation.box = null; }); state.attached = false; };
  const api = { scope, getSnapshot: snapshot, clear: () => { closeEditor(); state.annotations.forEach(annotation => annotation.box?.remove()); state.annotations = []; state.nextNumber = 1; restoreAll(); state.baselineByElement.clear(); bumpRevision(); return snapshot(); }, suspend: () => { closeEditor(); restoreAll(); detach(); return snapshot(); }, resume: () => { attach(); return snapshot(); }, destroy: () => { api.clear(); detach(); delete window.__WEWORK_BROWSER_ANNOTATION__; } };
  window.__WEWORK_BROWSER_ANNOTATION__ = api; attach(); return true;
})();`
}
