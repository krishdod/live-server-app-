const {test} = require("node:test");
const assert = require("node:assert/strict");
const {page,response,flush} = require("./ui-harness");
const row = {id:"session",createdAt:Date.now(),sender:"Meeting"};
const snapshot = { ...row, version:2,names:{"speaker-1":"Alex"},draft:"draft only",firstTurn:2,paired:true,state:"listening",lastSeen:Date.now(),turns:[{id:2,text:"<img src=x onerror=alert(1)> How do you scale?",speaker:"speaker-1",startedMs:1000,revision:2}]};
function bridge(h, handler = async () => ({ok:true})) {
  const requests=[];
  h.window.postMessage = async message => {
    if (message.direction !== "request") return;
    requests.push(message);
    const result=await handler(message);
    h.window.dispatchEvent(new h.window.MessageEvent("message",{source:h.window,origin:"https://workspace.test",data:{channel:message.channel,direction:"response",id:message.id,...result}}));
  };
  return requests;
}
test("transcript feed safely renders, renames and copies final phrases without draft text",async t=>{
  let data = structuredClone(snapshot);
  const h = await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async(url,init)=>{
    if (init.method === "POST") { const body=JSON.parse(init.body); assert.equal(body.action,"assign"); data={...data,version:3,turns:[{...data.turns[0],speaker:"speaker-2",revision:3}]}; return response({ok:true}); }
    return response(url.includes("snapshot")?data:{sessions:[row]});
  }});
  assert.equal(h.el("dashboard").hidden,false);
  assert.equal(h.el("turns").querySelector("img"),null);
  assert.match(h.el("turns").textContent,/How do you scale/);
  await h.click("copyLatest"); assert.equal(h.clipboard[0],`Alex: ${snapshot.turns[0].text}`);
  const select = h.el("turns").querySelector("select"); select.value="speaker-2"; select.dispatchEvent(new h.window.Event("change")); await flush();
  await h.tick(500); await h.click("copyLatest"); assert.match(h.clipboard.at(-1),/^Speaker 2:/);
  assert.equal(h.el("turns").children.length,1);
});
test("sign out discards an in-flight snapshot and clears visible transcript data",async t=>{
  let resolve;
  const h=await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async url=>url.includes("snapshot")?new Promise(done=>{resolve=done;}):response({sessions:[row]})});
  await h.click("signout"); resolve(response(snapshot)); await flush();
  assert.equal(h.el("dashboard").hidden,true); assert.equal(h.el("login").hidden,false);
  assert.equal(h.el("turns").children.length,0); assert.equal(h.el("code").textContent,"");
  assert.equal(h.timers.size,0);
});
test("auto-copy uses finished new phrases only, keeps speaker labels and stops when turned off",async t=>{
  let data=structuredClone(snapshot);
  const h=await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async url=>response(url.includes("snapshot")?data:{sessions:[row]})});
  const requests=bridge(h);
  await h.click("autoCopy"); await flush();
  assert.equal(h.el("autoCopy").getAttribute("aria-pressed"),"true");
  assert.deepEqual(requests.filter(r=>r.operation==="copy").map(r=>r.text),[`Alex: ${snapshot.turns[0].text}`]);
  data={...data,version:3,draft:"another unfinished draft",turns:[]}; await h.tick(500); await flush();
  assert.equal(requests.filter(r=>r.operation==="copy").length,1);
  data={...data,version:4,turns:[{...snapshot.turns[0],speaker:"speaker-2",revision:4}]}; await h.tick(500); await flush();
  assert.equal(requests.filter(r=>r.operation==="copy").length,1,"renaming or correcting an old turn does not overwrite the clipboard");
  data={...data,version:5,turns:[{id:5,speaker:"local",text:"my reply",startedMs:2000,revision:5},{id:6,speaker:"unknown",text:"short phrase",startedMs:3000,revision:5}]};
  await h.tick(500); await flush();
  assert.equal(requests.filter(r=>r.operation==="copy").at(-1).text,"Meeting host: my reply\n\nUnknown: short phrase");
  await h.click("autoCopy"); data={...data,version:6,turns:[{id:7,speaker:"speaker-1",text:"not copied",startedMs:4000,revision:6}]};
  await h.tick(500); await flush();
  assert.equal(requests.filter(r=>r.operation==="copy").length,2);
});
test("a clipboard failure pauses auto-copy and leaves manual copying available",async t=>{
  const h=await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async url=>response(url.includes("snapshot")?snapshot:{sessions:[row]})});
  bridge(h,async message=>message.operation==="check"?{ok:true}:{ok:false,error:"Clipboard access failed. Reload the extension."});
  await h.click("autoCopy"); await flush();
  assert.equal(h.el("autoCopy").getAttribute("aria-pressed"),"false");
  assert.match(h.el("clipboardStatus").textContent,/Clipboard access failed/);
  assert.equal(h.el("copyLatest").disabled,false);
});
test("turning auto-copy off cancels queued writes after an in-flight clipboard request",async t=>{
  let data=structuredClone(snapshot),finish;
  const h=await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async url=>response(url.includes("snapshot")?data:{sessions:[row]})});
  const requests=bridge(h,async message=>message.operation==="check"?{ok:true}:new Promise(resolve=>{finish=resolve;}));
  await h.click("autoCopy"); await flush();
  data={...data,version:3,turns:[{id:3,speaker:"speaker-1",text:"queued phrase",startedMs:1000,revision:3}]}; await h.tick(500);
  await h.click("autoCopy"); finish({ok:true}); await flush();
  assert.equal(requests.filter(r=>r.operation==="copy").length,1);
  assert.equal(h.el("autoCopy").getAttribute("aria-pressed"),"false");
});
test("missing updated extension explains the recovery without claiming a copy",async t=>{
  const h=await page(t,"transcripts",{storage:{"lw-key":"owner"},fetch:async url=>response(url.includes("snapshot")?snapshot:{sessions:[row]})});
  h.window.postMessage=()=>{};
  await h.click("autoCopy"); await h.tick(5000);
  assert.equal(h.el("autoCopy").getAttribute("aria-pressed"),"false");
  assert.match(h.el("clipboardStatus").textContent,/5\.4\.2/);
});
