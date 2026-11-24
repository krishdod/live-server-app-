"use strict";
const {app,BrowserWindow} = require("electron");
const {spawn,execFile} = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const root = path.join(__dirname,".."), output = path.join(root,"artifacts/meeting-captions/ui");
fs.mkdirSync(output,{recursive:true});
app.setPath("userData",fs.mkdtempSync(path.join(os.tmpdir(),"lw-transcript-")));
let server,window;
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<80;n++){if(await check())return;await delay(100);}throw new Error("UI timed out");}
const js = code=>window.webContents.executeJavaScript(code);
app.whenReady().then(async()=>{
  server=spawn(process.execPath,[path.join(__dirname,"server.js")],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1",PORT:"0",EDIT_KEY:"fixture-owner",STREAM_KEY:"fixture-publish",APP_PASSWORD:"",VIEW_KEY:"",APP_ORIGIN:"",RENDER:"",NODE_ENV:"test",SMTP_HOST:"",SMTP_USER:"",SMTP_PASS:""},stdio:["ignore","pipe","pipe"]});
  const port=await new Promise((resolve,reject)=>{let text="";server.stdout.on("data",chunk=>{text+=chunk;const match=text.match(/Server running on port (\d+)/);if(match)resolve(match[1]);});server.on("exit",code=>reject(new Error(`Relay exited ${code}`)));setTimeout(()=>reject(new Error("Relay timeout")),8000).unref();});
  const base=`http://127.0.0.1:${port}`;
  window=new BrowserWindow({show:false,width:1140,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL(`${base}/transcripts`);
  await js(`document.getElementById('key').value='fixture-owner'; document.getElementById('login').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await until(()=>js(`!document.getElementById('dashboard').hidden`));
  await js(`document.getElementById('create').click()`);
  await until(()=>js(`Boolean(document.getElementById('code').textContent)`));
  await delay(200);
  fs.writeFileSync(path.join(output,"pairing.png"),(await window.webContents.capturePage()).toPNG());
  const code=await js(`document.getElementById('code').textContent`);
  const python=path.join(root,"artifacts/meeting-captions/venv/Scripts/python.exe");
  await new Promise((resolve,reject)=>execFile(python,[path.join(root,"meeting-captions/relay-smoke.py"),"--server",base,"--models",path.join(root,"artifacts/meeting-captions/caption-models"),"--wav",path.join(root,"artifacts/meeting-captions/test.wav")],{windowsHide:true,env:{...process.env,LW_TEST_PAIR_CODE:code}},(error,stdout,stderr)=>error?reject(new Error(`${error.message}\n${stderr}`)):resolve(stdout)));
  await until(()=>js(`document.querySelectorAll('.turn').length===3`));
  await js(`document.getElementById('speakerName').value='Alex'; document.getElementById('rename').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await until(()=>js(`document.querySelector('.turn select').selectedOptions[0].textContent==='Alex'`));
  assert.equal(await js(`document.querySelectorAll('.turn')[1].querySelector('select').value`),"unknown");
  for(const [name,width,height] of [["desktop",1140,900],["mobile",390,844]]){
    window.setSize(width,height);await delay(250);
    const layout=await js(`({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('button')].filter(n=>n.offsetHeight).map(n=>({text:n.textContent,height:n.offsetHeight}))})`);
    assert.ok(layout.scroll<=layout.width,`${name} overflow`);
    fs.writeFileSync(path.join(output,`${name}.png`),(await window.webContents.capturePage()).toPNG());
  }
  await js(`document.getElementById('end').click()`);
  await until(()=>js(`document.getElementById('turns').children.length===0`));
  fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:true,checks:["local WAV recognition to Python sender to relay to owner UI","same-voice stability and unknown short phrase","manual speaker rename","desktop and mobile layout","end and erase"]},null,2));
  window.close();server.kill();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:false,error:error.stack},null,2));if(server)server.kill();app.exit(1);});
