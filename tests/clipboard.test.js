const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {JSDOM} = require("jsdom");
const source = name => fs.readFileSync(path.join(__dirname,"..",name),"utf8");

test("offscreen clipboard accepts the worker, rejects content-script senders, and clears its text", t => {
  const dom = new JSDOM(source("clipboard-offscreen.html")); t.after(()=>dom.window.close());
  let listener, copied=[];
  dom.window.document.execCommand = command => { assert.equal(command,"copy"); copied.push(dom.window.document.getElementById("clipboardText").value); return true; };
  vm.runInNewContext(source("clipboard-offscreen.js"),{document:dom.window.document,chrome:{runtime:{id:"extension",onMessage:{addListener(fn){listener=fn;}}}}});
  const msg={target:"lw-clipboard-offscreen",type:"copy-text",text:"Alex: A finished caption"};
  let result;
  listener(msg,{id:"extension",tab:{id:1}},value=>{result=value;});
  listener(msg,{id:"foreign"},value=>{result=value;});
  assert.equal(result,undefined); assert.deepEqual(copied,[]);
  listener(msg,{id:"extension"},value=>{result=value;});
  assert.equal(result.ok,true); assert.deepEqual(copied,[msg.text]);
  assert.equal(dom.window.document.getElementById("clipboardText").value,"");
  dom.window.document.execCommand=()=>false;
  listener(msg,{id:"extension"},value=>{result=value;}); assert.equal(result.ok,false);
});

test("page clipboard bridge forwards only its fixed protocol from the matching window origin", async () => {
  let listener;
  const forwarded=[], replies=[];
  const window={addEventListener(type,fn){assert.equal(type,"message");listener=fn;},postMessage(message){replies.push(message);}};
  vm.runInNewContext(source("clipboard-bridge.js"),{window,location:{origin:"https://workspace.onrender.com",pathname:"/transcripts"},chrome:{runtime:{async sendMessage(message){forwarded.push(message);return {ok:true};}}}});
  const data={channel:"lw-transcript-clipboard-v1",direction:"request",id:1,operation:"copy",text:"caption",key:"must never forward",target:"arbitrary"};
  await listener({source:{},origin:"https://workspace.onrender.com",data});
  await listener({source:window,origin:"https://other.example",data});
  await listener({source:window,origin:"https://workspace.onrender.com",data:{...data,operation:"save-connection"}});
  assert.equal(forwarded.length,0);
  await listener({source:window,origin:"https://workspace.onrender.com",data});
  assert.equal(JSON.stringify(forwarded[0]),JSON.stringify({type:"transcript-clipboard",operation:"copy",text:"caption"}));
  assert.equal(replies[0].ok,true); assert.equal(replies[0].id,1);
});
