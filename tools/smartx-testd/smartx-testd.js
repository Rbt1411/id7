'use strict';
/* Standalone one-shot SmartX probe. NO persistent playback and NO D-Bus mutations. */
const fs=require('fs'), net=require('net'), cp=require('child_process'), path=require('path');
const DIR=__dirname;
const SOCKETS=['/run/smartx-testd/probe.sock','/tmp/smartx-testd.sock'];
const DEVICE='plug:smartx:CarLifeMedia_CF_48_STEREO';
const SCRIPT=path.join(DIR,'smartx-tone.py');
let busy=false, lastStart=0, child=null, servers=[];
function python(){
 const c=['/usr/bin/python3','/usr/local/bin/python3','/bin/python3'];
 for(const p of c)if(fs.existsSync(p))return p;
 // mgu-python is often installed as an MGU Store tool under /var/opt, not in PATH.
 let dirs=[];try{dirs=fs.readdirSync('/var/opt');}catch(e){}
 const rel=['current/bin/python3','current/bin/python3.12','current/python3','current/python/bin/python3','current/usr/bin/python3','bin/python3'];
 for(const d of dirs){if(d.indexOf('python')<0)continue;for(const r of rel){const p=path.join('/var/opt',d,r);try{fs.accessSync(p,fs.constants.X_OK);return p;}catch(e){}}}
 return 'python3';
}
function reply(sock,obj){try{sock.write(JSON.stringify(obj)+'\n');}catch(e){}}
function doTest(sock){
 if(busy){reply(sock,{ok:false,error:'Test laeuft bereits'});return;}
 if(Date.now()-lastStart<15000){reply(sock,{ok:false,error:'15 Sekunden Pause zwischen Tests'});return;}
 const py=python();if(!py){reply(sock,{ok:false,error:'Python fehlt'});return;}
 busy=true;lastStart=Date.now();let end='',err='',done=false;
 try {child=cp.spawn(py,[SCRIPT,DEVICE],{cwd:DIR,stdio:['ignore','pipe','pipe']});}
 catch(e){busy=false;reply(sock,{ok:false,error:e.message});return;}
 const c=child;
 c.stdout.setEncoding('utf8');c.stderr.setEncoding('utf8');
 c.stdout.on('data',d=>{end=(end+d).slice(-1000);});
 c.stderr.on('data',d=>{err=(err+d).slice(-1000);});
 const timeout=setTimeout(()=>{try{c.kill('SIGKILL');}catch(e){}},4000);
 function finish(code){if(done)return;done=true;clearTimeout(timeout);busy=false;child=null;reply(sock,{ok:code===0,output:end.trim().slice(0,180),error:code===0?null:(err.trim().slice(0,240)||'exit '+code)});}
 c.on('exit',(code)=>finish(code));c.on('error',(e)=>finish(-1));
}
for(const file of SOCKETS){
 try{fs.mkdirSync(path.dirname(file),0o755);}catch(e){}
 try{fs.unlinkSync(file);}catch(e){}
 const s=net.createServer(sock=>{
    sock.setEncoding('utf8');let buf='',handled=false;
    sock.on('data',d=>{
      buf+=d;if(buf.length>512){sock.destroy();return;}
      const i=buf.indexOf('\n');if(i<0||handled)return;handled=true;
      let req;try{req=JSON.parse(buf.slice(0,i));}catch(e){return reply(sock,{ok:false,error:'JSON ungueltig'});}
      if(req.op==='status')reply(sock,{ok:true,device:DEVICE,busy:busy});
      else if(req.op==='stop'){if(child){try{child.kill('SIGTERM');}catch(e){}}reply(sock,{ok:true});}
      else if(req.op==='test')doTest(sock);
      else reply(sock,{ok:false,error:'Befehl nicht erlaubt'});
    });
  });
 s.on('error',e=>{console.error(file+': '+e.message);});
 s.listen(file,()=>{try{fs.chmodSync(file,0o666);}catch(e){}console.log('SmartX probe: '+file);});
 servers.push({s,file});
}
function shutdown(){if(child){try{child.kill('SIGTERM');}catch(e){}}servers.forEach(x=>{try{x.s.close();fs.unlinkSync(x.file);}catch(e){}});setTimeout(()=>process.exit(0),100);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
