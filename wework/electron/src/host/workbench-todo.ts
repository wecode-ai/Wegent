const TODO_COPY = {
  en: {
    title: 'TODO note',
    pin: 'Keep on top',
    hide: 'Hide',
    add: 'Add',
    placeholder: 'Add a task',
    remove: 'Delete',
    retry: 'Retry loading',
    invalid: 'Saved tasks could not be read. Your data has been preserved.',
    loading: 'Loading tasks…',
  },
  zh: {
    title: 'TODO 便签',
    pin: '置顶',
    hide: '收起',
    add: '添加',
    placeholder: '添加待办事项',
    remove: '删除',
    retry: '重新加载',
    invalid: '无法读取已保存的待办，原有数据已保留。',
    loading: '正在加载待办…',
  },
}

export function createTodoHtml(locale: string): string {
  const language = locale.startsWith('zh') ? 'zh' : 'en'
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TODO</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#fff,#181818);color:light-dark(#202020,#fafafa)}
*{box-sizing:border-box}body{margin:0;padding:20px}h1{font:inherit;font-weight:500;margin:0}#editor{display:flex;flex-wrap:wrap;gap:8px}input,button{font:inherit;border:1px solid light-dark(#ddd,#444);border-radius:8px;padding:10px;background:transparent;color:inherit}input[type=text]{flex:1;min-width:140px}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #339cff;outline-offset:2px}.primary{background:light-dark(#222,#eee);color:light-dark(#fff,#181818)}ul{padding:0;list-style:none}li{display:flex;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid light-dark(#eee,#333)}li label{flex:1;overflow-wrap:anywhere}li input{width:20px;height:20px}.done{text-decoration:line-through;opacity:.5}#status{min-height:1.5em;opacity:.75}.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px}.toolbar h1{flex:1}.remove{min-width:44px;min-height:44px}button[disabled]{opacity:.5;cursor:wait}
</style></head><body>
<div class="toolbar"><h1 id="title"></h1><button id="pin" data-testid="todo-pin" aria-pressed="false" disabled></button><button id="hide" data-testid="todo-hide"></button></div>
<div id="editor"><input id="text" data-testid="todo-input" type="text" maxlength="500" disabled><button id="add" data-testid="todo-add" type="button" class="primary" disabled></button></div>
<p id="status" data-testid="todo-status" role="status" aria-live="polite"></p><button id="retry" data-testid="todo-retry" hidden></button><ul id="items" data-testid="todo-items"></ul>
<script>
const copy=${JSON.stringify(TODO_COPY[language])};
const sdk=window.weworkWorkbench;
const byId=id=>document.getElementById(id);
const text=byId('text'),status=byId('status'),list=byId('items'),retry=byId('retry');
let items=[],pinned=false,pending=false,ready=false;
document.title=copy.title;byId('title').textContent=copy.title;
for(const id of ['pin','hide','add','retry'])byId(id).textContent=copy[id];
text.placeholder=copy.placeholder;text.setAttribute('aria-label',copy.placeholder);
const fail=error=>{status.textContent=error.message||String(error)};
function controls(){for(const element of document.querySelectorAll('#editor input,#editor button,#pin,#items input,#items button'))element.disabled=pending||!ready}
function render(){
  list.replaceChildren();
  for(const item of items){
    const row=document.createElement('li'),check=document.createElement('input'),label=document.createElement('label'),remove=document.createElement('button');
    check.type='checkbox';check.checked=item.done;check.id='check-'+item.id;check.dataset.testid='todo-check-'+item.id;
    label.htmlFor=check.id;label.textContent=item.text;if(item.done)label.className='done';
    remove.textContent=copy.remove;remove.className='remove';remove.dataset.testid='todo-delete-'+item.id;remove.setAttribute('aria-label',copy.remove+' '+item.text);
    check.onchange=()=>mutate(async()=>{
      const done=check.checked;
      await commit(items.map(current=>current.id===item.id?{...current,done}:current));
    });
    remove.onclick=()=>mutate(()=>commit(items.filter(current=>current.id!==item.id)));
    row.append(check,label,remove);list.append(row);
  }
  controls();
}
async function commit(next){
  await sdk.storage.set(next);
  items=next;render();
}
async function mutate(action){
  if(pending||!ready)return;
  pending=true;controls();status.textContent='';
  try{await action()}catch(error){fail(error);render()}finally{pending=false;controls()}
}
function add(){
  const value=text.value.trim();if(!value)return;
  return mutate(async()=>{
    const item={id:crypto.randomUUID(),text:value,done:false};
    await commit([...items,item]);
    text.value='';text.focus();
  });
}
byId('add').onclick=add;
text.onkeydown=event=>{
  if(event.key!=='Enter'||event.isComposing||event.keyCode===229)return;
  event.preventDefault();add();
};
byId('pin').onclick=()=>mutate(async()=>{await sdk.window.setAlwaysOnTop(!pinned);pinned=!pinned;byId('pin').setAttribute('aria-pressed',String(pinned))});
byId('hide').onclick=()=>sdk.window.hide().catch(fail);
async function load(){
  ready=false;retry.hidden=true;controls();status.textContent=copy.loading;
  try{
    const saved=await sdk.storage.get();
    if(saved!==null&&(!Array.isArray(saved)||saved.some(item=>!item||typeof item.id!=='string'||typeof item.text!=='string'||typeof item.done!=='boolean')))throw new Error(copy.invalid);
    items=saved||[];ready=true;status.textContent='';render();text.focus();
  }catch(error){fail(error);retry.hidden=false;controls()}
}
retry.onclick=load;load();
</script></body></html>`
}
