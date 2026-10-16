// Geometry-backed observers run inside QuickJS, after the DOM/layout bridge.
export const OBSERVER_WIRE=String.raw`
(()=>{
  class GeometryObserver {
    constructor(callback){if(typeof callback!=='function')throw new TypeError('callback required');this.callback=callback;this.targets=new Map();this.queued=false;this.mutation=null;this.onChange=()=>this.schedule();}
    observe(target){if(!target||target.nodeType!==1)throw new TypeError('Element required');if(!this.targets.has(target))this.targets.set(target,null);if(!this.mutation){this.mutation=new MutationObserver(this.onChange);this.mutation.observe(document,{subtree:true,attributes:true,childList:true,characterData:true});addEventListener('scroll',this.onChange);addEventListener('resize',this.onChange);}this.schedule();}
    unobserve(target){this.targets.delete(target);if(!this.targets.size)this.disconnect();}
    disconnect(){this.targets.clear();this.mutation?.disconnect();this.mutation=null;removeEventListener('scroll',this.onChange);removeEventListener('resize',this.onChange);}
    schedule(){if(this.queued)return;this.queued=true;setTimeout(()=>{this.queued=false;const entries=this.takeRecords();if(entries.length)this.callback(entries,this);},16);}
    takeRecords(){const entries=[];for(const [target,old] of this.targets){const entry=this.measure(target,old);if(entry){this.targets.set(target,entry);entries.push(entry);}}return entries;}
  }
  globalThis.ResizeObserver=class ResizeObserver extends GeometryObserver {
    measure(target,old){const rect=target.getBoundingClientRect();if(old&&old.borderBoxSize[0].inlineSize===rect.width&&old.borderBoxSize[0].blockSize===rect.height)return null;
      const style=getComputedStyle(target),n=k=>parseFloat(style.getPropertyValue(k))||0;
      const width=Math.max(0,rect.width-n('padding-left')-n('padding-right')-n('border-left-width')-n('border-right-width')),height=Math.max(0,rect.height-n('padding-top')-n('padding-bottom')-n('border-top-width')-n('border-bottom-width'));
      return {target,contentRect:{x:n('padding-left'),y:n('padding-top'),width,height,top:n('padding-top'),left:n('padding-left'),right:n('padding-left')+width,bottom:n('padding-top')+height},contentBoxSize:[{inlineSize:width,blockSize:height}],borderBoxSize:[{inlineSize:rect.width,blockSize:rect.height}],devicePixelContentBoxSize:[{inlineSize:width*devicePixelRatio,blockSize:height*devicePixelRatio}]};
    }
  };
  globalThis.IntersectionObserver=class IntersectionObserver extends GeometryObserver {
    constructor(callback,options={}){super(callback);this.root=options.root||null;this.rootMargin=options.rootMargin||'0px';this.thresholds=[...new Set([].concat(options.threshold??0))].sort((a,b)=>a-b);if(this.thresholds.some(t=>t<0||t>1))throw new RangeError('threshold');}
    measure(target,old){const b=target.getBoundingClientRect(),root=this.root&&this.root.nodeType!==9?this.root.getBoundingClientRect():{left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight};
      const parts=this.rootMargin.trim().split(/\s+/),m=parts.map(v=>parseFloat(v)*(v.endsWith('%')?root.width/100:1));const [top,right=top,bottom=top,left=right]=m;
      const rootBounds={left:root.left-left,top:root.top-top,right:root.right+right,bottom:root.bottom+bottom};rootBounds.width=rootBounds.right-rootBounds.left;rootBounds.height=rootBounds.bottom-rootBounds.top;rootBounds.x=rootBounds.left;rootBounds.y=rootBounds.top;
      const x=Math.max(rootBounds.left,b.left),y=Math.max(rootBounds.top,b.top),r=Math.min(rootBounds.right,b.right),d=Math.min(rootBounds.bottom,b.bottom),isIntersecting=target.isConnected&&(b.width>0||b.height>0)&&r>=x&&d>=y;
      const width=Math.max(0,r-x),height=Math.max(0,d-y),ratio=b.width*b.height?width*height/(b.width*b.height):isIntersecting?1:0;
      if(old&&old.isIntersecting===isIntersecting&&!this.thresholds.some(t=>(old.intersectionRatio<t)!==(ratio<t)))return null;
      return {target,time:performance.now(),rootBounds,boundingClientRect:b,intersectionRect:{x,y,left:x,top:y,right:x+width,bottom:y+height,width,height},intersectionRatio:ratio,isIntersecting};
    }
  };
})();
`;
