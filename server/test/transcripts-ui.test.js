const {test} = require("node:test");
const assert = require("node:assert/strict");
const {page,response,flush} = require("./ui-harness");
const row = {id:"session",createdAt:Date.now(),sender:"Meeting"};
const snapshot = { ...row, version:2,names:{"speaker-1":"Alex"},draft:"draft only",firstTurn:2,paired:true,state:"listening",lastSeen:Date.now(),turns:[{id:2,text:"<img src=x onerror=alert(1)> How do you scale?",speaker:"speaker-1",startedMs:1000,revision:2}]};
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
