import {label} from 'demo-data';
const target=document.querySelector('#out');
const observer=new MutationObserver(()=>{document.querySelector('#observed').textContent='MutationObserver delivered';observer.disconnect();});
observer.observe(target,{childList:true});
target.textContent=label;
