import { getScrollViewportElement } from '@wegent/collaboration/conversation'

const WHEEL_MESSAGE_TYPE = 'wework-inline-visualization-wheel'
const MODIFIER_KEYS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const

export function withVisualizationWheel(html: string, token: string): string {
  return `${html}\n<script>${createVisualizationWheelScript(token)}</script>`
}

export function forwardVisualizationWheel(
  frame: HTMLIFrameElement,
  value: unknown,
  token: string
): void {
  if (typeof value !== 'object' || value === null) return
  const data = value as Record<string, unknown>
  if (
    data.type !== WHEEL_MESSAGE_TYPE ||
    data.token !== token ||
    typeof data.deltaX !== 'number' ||
    !Number.isFinite(data.deltaX) ||
    typeof data.deltaY !== 'number' ||
    !Number.isFinite(data.deltaY) ||
    MODIFIER_KEYS.some(key => typeof data[key] !== 'boolean') ||
    data.ctrlKey ||
    data.metaKey ||
    (!data.deltaX && !data.deltaY)
  ) {
    return
  }
  const viewport = getScrollViewportElement(frame)
  if (!viewport) return
  const wheel = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: data.deltaX,
    deltaY: data.deltaY,
    altKey: data.altKey as boolean,
    shiftKey: data.shiftKey as boolean,
  })
  // Record user intent through the existing conversation controller before moving its viewport.
  if (frame.dispatchEvent(wheel)) {
    viewport.scrollBy({ left: data.deltaX, top: data.deltaY, behavior: 'instant' })
  }
}

/** Runs inside the opaque-origin document; only unconsumed pixel deltas cross the boundary. */
export function createVisualizationWheelScript(token: string): string {
  return `(()=>{
    const token=${JSON.stringify(token)};
    const root=document.scrollingElement||document.documentElement;
    document.documentElement.style.setProperty('overscroll-behavior','none','important');
    root.style.setProperty('overscroll-behavior','none','important');
    const elementsFor=event=>{
      const elements=[];
      for(const node of event.composedPath()){
        if(!(node instanceof Element)) continue;
        elements.push(node);
        if(node===root) break;
      }
      if(root&&!elements.includes(root)) elements.push(root);
      return elements;
    };
    const planAxis=(elements,delta,horizontal)=>{
      let remaining=delta;
      const steps=[];
      for(const element of elements){
        if(!remaining) break;
        const style=getComputedStyle(element);
        const isRoot=element===root;
        const overflow=horizontal?style.overflowX:style.overflowY;
        if(isRoot?['hidden','clip'].includes(overflow):!['auto','scroll','overlay'].includes(overflow)) continue;
        const maximum=Math.max(0,horizontal?element.scrollWidth-element.clientWidth:element.scrollHeight-element.clientHeight);
        const reversed=horizontal?style.direction==='rtl'||style.flexDirection==='row-reverse':style.flexDirection==='column-reverse';
        const minimum=reversed?-maximum:0,maximumPosition=reversed?0:maximum;
        const position=horizontal?element.scrollLeft:element.scrollTop;
        const amount=Math.max(minimum,Math.min(maximumPosition,position+remaining))-position;
        if(amount) steps.push({element,amount});
        remaining-=amount;
        const overscroll=(horizontal?style.overscrollBehaviorX:style.overscrollBehaviorY)||style.overscrollBehavior;
        if(!isRoot&&['contain','none'].includes(overscroll)) remaining=0;
      }
      return {remaining,steps};
    };
    addEventListener('wheel',event=>{
      if(event.defaultPrevented||!event.cancelable) return;
      if(event.ctrlKey||event.metaKey){event.preventDefault();return;}
      const elements=elementsFor(event);
      if(elements.some(element=>element===document.activeElement&&element.matches('input[type="number"],select'))) return;
      const style=getComputedStyle(elements[0]||document.documentElement);
      const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2||16;
      const unit=event.deltaMode===1?lineHeight:1;
      const x=planAxis(elements,event.deltaX*(event.deltaMode===2?root.clientWidth:unit),true);
      const y=planAxis(elements,event.deltaY*(event.deltaMode===2?root.clientHeight:unit),false);
      if(!x.remaining&&!y.remaining) return;
      event.preventDefault();
      for(const {element,amount} of x.steps) element.scrollBy({left:amount,behavior:'instant'});
      for(const {element,amount} of y.steps) element.scrollBy({top:amount,behavior:'instant'});
      parent.postMessage({type:${JSON.stringify(WHEEL_MESSAGE_TYPE)},token,deltaX:x.remaining,deltaY:y.remaining,
        altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey},'*');
    },{passive:false});
  })()`
}
