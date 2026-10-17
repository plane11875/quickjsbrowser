// Runs inside QuickJS. Stable node identities are attached only to a cloned render tree.
export const LAYOUT_WIRE = String.raw`
(() => {
  let ids=new WeakMap(),nodes=new Map(),next=0,lastSource=null,lastHTML='';
  globalThis.__layout_reset=()=>{ids=new WeakMap();nodes=new Map();next=0;lastSource=null;};
  const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const escapeText=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escapeAttribute=value=>escapeText(value).replace(/"/g,'&quot;');
  const projectSource=()=>{
    const paths=new Set();
    for(const script of document.querySelectorAll('script'))if(script.firstChild)for(let node=script;node;node=node.parentNode)paths.add(node);
    const project=node=>{
      if(node.nodeType===8)return '<!--'+node.data+'-->';
      if(!paths.has(node))return node.outerHTML??escapeText(node.data||'');
      if(node.nodeType!==1)return Array.from(node.childNodes,project).join('');
      let open='<'+node.localName;for(const a of node.attributes)open+=' '+a.name+'="'+escapeAttribute(a.value)+'"';open+='>';
      return open+(node.localName==='script'?'':Array.from(node.childNodes,project).join(''))+'</'+node.localName+'>';
    };
    return project(document.documentElement);
  };
  const snapshot=(force=false)=>{
    const source=projectSource();
    if(!force&&source===lastSource)return lastHTML;
    const original=[document.documentElement,...document.documentElement.querySelectorAll('*')];
    if(original.length>10000)throw new Error('layout node budget exceeded');
    nodes.clear();let index=0,cursor=0;const chunks=[],lower=source.toLowerCase();
    // Skip comments and quoted attribute contents, plus raw-text style bodies.
    const tags=/<!--[\s\S]*?-->|<![^>]*>|<\/?([A-Za-z][\w:-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
    let match;while((match=tags.exec(source))){
      if(!match[1]||match[0][1]==='/')continue;
      const node=original[index++];if(!node)throw new Error('layout serialization mismatch');
      let id=ids.get(node);if(!id){id=String(++next);ids.set(node,id);}nodes.set(id,node);
      const tag=match[0].replace(/\sdata-qjs-node="[^"]*"/gi,'').replace(/(\/?>)$/, ' data-qjs-node="'+id+'"$1');
      chunks.push(source.slice(cursor,match.index),tag);cursor=match.index+match[0].length;
      if(/^(script|style)$/i.test(match[1])){const end=lower.indexOf('</'+match[1].toLowerCase(),cursor);if(end>=0)tags.lastIndex=end;}
    }
    chunks.push(source.slice(cursor));lastSource=source;lastHTML=chunks.join('');return lastHTML;
  };
  const query=(el,property='',x=0,y=0)=>{
    if(el && !el.isConnected)return {x:0,y:0,width:0,height:0,value:''};
    const html=snapshot(!el||!ids.has(el)),id=el?ids.get(el):null;
    const r=__hostLayout(JSON.stringify({html,selector:id?'[data-qjs-node="'+id+'"]':'',property,x,y}));
    if(r.error)throw new Error(r.error);return r;
  };
  const rect=(el)=>{const r=query(el);const x=r.x||0,y=r.y||0,width=r.width||0,height=r.height||0;return {x,y,width,height,left:x,top:y,right:x+width,bottom:y+height,toJSON(){return {x,y,width,height,left:x,top:y,right:x+width,bottom:y+height};}};};
  globalThis.__layout_install=()=>{
    const proto=globalThis.Element.prototype;
    for(const key of ['scrollTop','scrollLeft'])if(!(key in proto))Object.defineProperty(proto,key,{configurable:true,get(){return this['__'+key]||0;},set(v){this['__'+key]=Math.max(0,Number(v)||0);}});
    proto.getBoundingClientRect=function(){return rect(this);};
    proto.getClientRects=function(){const r=rect(this);const out=r.width||r.height?[r]:[];out.item=i=>out[i]||null;return out;};
    for(const [name,field] of [['offsetWidth','width'],['offsetHeight','height'],['clientWidth','width'],['clientHeight','height']])Object.defineProperty(proto,name,{configurable:true,get(){return Math.round(rect(this)[field]);}});
    globalThis.getComputedStyle=(el,pseudo)=>new Proxy({getPropertyValue(name){return String(query(el,String(name)).value||'');},item(){return '';},length:0}, {get(target,key){if(key in target)return target[key];if(typeof key!=='string')return undefined;return target.getPropertyValue(key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()));}});
    document.elementFromPoint=(x,y)=>{const r=query(null,'@hit',Number(x),Number(y));return nodes.get(r.id)||null;};
    document.elementsFromPoint=(x,y)=>{const n=document.elementFromPoint(x,y);return n?[n]:[];};
  };
})();
`;
