import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
export class Bridge {
  constructor(){this.pending=new Map();this.counter=0;this.stopped=false;}
  start(){
    if(this.stopped)throw Error('Gateway companion is stopping');
    if(this.child)return;
    const child=spawn(process.execPath,[fileURLToPath(new URL('./rpc-bridge.js',import.meta.url))],{stdio:['pipe','pipe','ignore']});this.child=child;
    createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{return;}const pending=this.pending.get(r.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(r.id);r.error?pending.reject(Error(r.error)):pending.resolve(r.result);});
    child.on('error',()=>{if(this.child===child)this.fail();});child.on('exit',()=>{if(this.child===child)this.fail();});
  }
  fail(){this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Gateway companion interrupted; reconcile before retry'));}this.pending.clear();}
  request(method,params){this.start();const id=++this.counter;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Gateway companion timeout; reconcile before retry'));},25000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});}
  stop(){this.stopped=true;this.child?.kill();this.fail();}
}
