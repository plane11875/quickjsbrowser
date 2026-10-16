// Runs inside QuickJS. Stable node identities are attached only to a cloned render tree.
export const LAYOUT_WIRE = String.raw`
(() => {
  let ids=new WeakMap(),nodes=new Map(),next=0,lastSource=null,lastHTML='';
  globalThis.__layout_reset=()=>{ids=new WeakMap();nodes=new Map();next=0;lastSource=null;};
  const snapshot=()=>{
    const source=document.documentElement.outerHTML;
    if(source===lastSource)return lastHTML;
    const clone=document.documentElement.cloneNode(true),original=[document.documentElement,...document.documentElement.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
    if(original.length>10000)throw new Error('layout node budget exceeded');
    nodes.clear();
    for(let i=0;i<original.length;i++){let id=ids.get(original[i]);if(!id){id=String(++next);ids.set(original[i],id);}nodes.set(id,original[i]);copies[i].setAttribute('data-qjs-node',id);}
    lastSource=source;lastHTML=clone.outerHTML;return lastHTML;
  };
  const query=(el,property='',x=0,y=0)=>{
    if(el && !el.isConnected)return {x:0,y:0,width:0,height:0,value:''};
    const html=snapshot(),id=el?ids.get(el):null;
    const r=__hostLayout(JSON.stringify({html,selector:id?'[data-qjs-node="'+id+'"]':'',property,x,y}));
    if(r.error)throw new Error(r.error);return r;
  };
  const rect=(el)=>{const r=query(el);const x=r.x||0,y=r.y||0,width=r.width||0,height=r.height||0;return {x,y,width,height,left:x,top:y,right:x+width,bottom:y+height,toJSON(){return {x,y,width,height,left:x,top:y,right:x+width,bottom:y+height};}};};
  globalThis.__layout_install=()=>{
    const proto=globalThis.Element.prototype;
    proto.getBoundingClientRect=function(){return rect(this);};
    proto.getClientRects=function(){const r=rect(this);const out=r.width||r.height?[r]:[];out.item=i=>out[i]||null;return out;};
    for(const [name,field] of [['offsetWidth','width'],['offsetHeight','height'],['clientWidth','width'],['clientHeight','height']])Object.defineProperty(proto,name,{configurable:true,get(){return Math.round(rect(this)[field]);}});
    globalThis.getComputedStyle=(el,pseudo)=>new Proxy({getPropertyValue(name){return String(query(el,String(name)).value||'');},item(){return '';},length:0}, {get(target,key){if(key in target)return target[key];if(typeof key!=='string')return undefined;return target.getPropertyValue(key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()));}});
    document.elementFromPoint=(x,y)=>{const r=query(null,'@hit',Number(x),Number(y));return nodes.get(r.id)||null;};
    document.elementsFromPoint=(x,y)=>{const n=document.elementFromPoint(x,y);return n?[n]:[];};
  };
})();
`;
