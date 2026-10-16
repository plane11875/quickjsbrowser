export const INPUT_WIRE=String.raw`
(() => {
  let pressed=null;
  const send=(node,type,init={})=>{
    const event=new globalThis.Event(type,{bubbles:true,cancelable:true});
    for(const key of Object.keys(init))try{Object.defineProperty(event,key,{value:init[key],configurable:true});}catch(e){}
    node.dispatchEvent(event);return event;
  };
  const activate=(node,init={})=>{
    if(!node||node.disabled)return;
    const event=send(node,'click',init);
    if(event.defaultPrevented)return;
    const a=node.closest&&node.closest('a[href]');
    if(a){const href=a.getAttribute('href');if(href&& !/^javascript:/i.test(href))__hostEnqueue('navigate',JSON.stringify({url:new URL(href,document.baseURI).href}));}
    if(node.localName==='input'&&['checkbox','radio'].includes(node.type)){node.checked=node.type==='radio'?true:!node.checked;send(node,'input');send(node,'change');}
  };
  globalThis.__input_install=()=>{
    pressed=null;
    globalThis.HTMLElement.prototype.click=function(){activate(this,{button:0,detail:1});};
    for(const node of document.querySelectorAll('*'))for(const attr of node.attributes){
      if(/^on(click|mousedown|mouseup|input|change|submit)$/.test(attr.name)){
        const type=attr.name.slice(2),code=attr.value;
        node.addEventListener(type,function(event){if(new Function('event',code).call(this,event)===false)event.preventDefault();});
      }
    }
  };
  globalThis.__input_mouse=(payload)=>{
    const p=JSON.parse(payload),x=Number(p.x),y=Number(p.y),node=document.elementFromPoint(x,y);
    if(!node){pressed=null;return {hit:false};}
    const init={clientX:x,clientY:y,button:p.button==='right'?2:p.button==='middle'?1:0,buttons:p.buttons||0,detail:p.clickCount||1};
    if(p.type==='mouseMoved')send(node,'mousemove',init);
    else if(p.type==='mousePressed'){pressed=node;send(node,'mousedown',init);if(typeof node.focus==='function')node.focus();}
    else if(p.type==='mouseReleased'){send(node,'mouseup',init);if(pressed===node&&init.button===0)activate(node,init);pressed=null;}
    else throw new Error('unsupported mouse event type');
    return {hit:true,tag:node.localName};
  };
})();
`;
