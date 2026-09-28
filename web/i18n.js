import { UI_STRINGS } from './ui-strings.js';
// Translate UI text in place. No DOM reconstruction, no translation of game,
// script, memory, filename or packet data. IDs/data-i18n identify bound elements.
const byJa = new Map(UI_STRINGS.map(([ja,en], i) => [ja, {key:`text-${i}`,ja,en}]));
const byEn = new Map([...byJa.values()].map(entry => [entry.en,entry]));
function lookup(value) {
  const trimmed=value.trim(), entry=byJa.get(trimmed)||byEn.get(trimmed);
  if(entry)return {...entry,prefix:value.slice(0,value.indexOf(trimmed)),suffix:value.slice(value.indexOf(trimmed)+trimmed.length)};
  let m=trimmed.match(/^(\d+) \/ 16 台 · (\d+) ツール$/)||trimmed.match(/^(\d+) \/ 16 instances · (\d+) tools$/);
  if(m)return {key:'summary',ja:`${m[1]} / 16 台 · ${m[2]} ツール`,en:`${m[1]} / 16 instances · ${m[2]} tools`};
  m=trimmed.match(/^(#\d+) · (未作成|not created)$/);
  if(m)return {key:'uncreated',ja:`${m[1]} · 未作成`,en:`${m[1]} · not created`};
  m=trimmed.match(/^(#\d+) と連動$/)||trimmed.match(/^Link with (#\d+)$/);
  if(m)return {key:'input-link',ja:`${m[1]} と連動`,en:`Link with ${m[1]}`};
  m=trimmed.match(/^(BIOS[79]|Firmware): (実機|Native|読込済み|Loaded|内蔵|Built-in)$/);
  if(m){const s=byJa.get(m[2])||byEn.get(m[2]);return {key:'system-state',ja:`${m[1]}: ${s.ja}`,en:`${m[1]}: ${s.en}`};}
  return null;
}
export function installLanguageSwitcher() {
  const select=document.getElementById('ui-language');
  let language='ja',serial=0;
  try{language=localStorage.getItem('melonds.language')==='en'?'en':'ja';}catch{}
  select.value=language;
  const excluded='script,style,textarea,pre,code,.file-item,.network-detail,.file-details,.register-grid,.disassembly-table,.memory-table,.script-output';
  const assign=(element,entry)=>{if(!element.id)element.id=`melonds-ui-${++serial}`;if(element.dataset.i18n!==entry.key)element.dataset.i18n=entry.key;};
  function update(root) {
    if(root.nodeType===Node.TEXT_NODE){
      const parent=root.parentElement;
      if(!parent||parent.closest(excluded))return;
      const entry=lookup(root.nodeValue);if(!entry)return;
      assign(parent,entry);
      const value=`${entry.prefix||''}${entry[language]}${entry.suffix||''}`;
      if(root.nodeValue!==value)root.nodeValue=value;
      return;
    }
    if(!(root instanceof Element)||root.matches(excluded))return;
    for(const name of ['aria-label','title','placeholder']){
      const value=root.getAttribute(name);if(!value)continue;
      const entry=lookup(value);if(!entry)continue;
      assign(root,entry);if(value!==entry[language])root.setAttribute(name,entry[language]);
    }
    for(const child of root.childNodes)update(child);
  }
  const observer=new MutationObserver(records=>{
    const roots=new Set();
    for(const record of records){if(record.type==='childList')record.addedNodes.forEach(node=>roots.add(node));else roots.add(record.target);}
    roots.forEach(update);
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','placeholder']});
  const apply=()=>{document.documentElement.lang=language;update(document.body);};
  select.onchange=()=>{language=select.value==='en'?'en':'ja';try{localStorage.setItem('melonds.language',language);}catch{}apply();};
  apply();
}
