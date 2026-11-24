const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TranscriptStore, TTL, PAIR_TTL } = require("../transcripts");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");

test("one-use pairing creates an upload-only capability and keeps secrets out of snapshots", () => {
  const store = new TranscriptStore();
  const session = store.create();
  const pair = store.pair(session.pairCode, "Meeting PC", "ip");
  assert.throws(() => store.pair(session.pairCode, "Other PC", "ip"), { status:403 });
  const snapshot = store.snapshot(session.id);
  assert.equal(snapshot.pairCode, "");
  assert.equal(snapshot.token, undefined);
  assert.equal(snapshot.tokenHash, undefined);
  assert.equal(pair.token.length, 64);
});

test("pair codes and sessions expire, attempts are bounded, ending erases captions", () => {
  let now = 0;
  const store = new TranscriptStore({ now:()=>now });
  const expired = store.create(); now += PAIR_TTL;
  assert.throws(() => store.pair(expired.pairCode, "A", "ip"), { status:403 });
  for (let i=0; i<9; i++) assert.throws(() => store.pair("bad", "A", "ip"), { status:403 });
  assert.throws(() => store.pair("bad", "A", "ip"), { status:429 });
  const session = store.create(), pair = store.pair(session.pairCode,"B","other");
  store.end(session.id);
  assert.throws(() => store.ingest(pair.token,{seq:1,type:"status",state:"listening"}), {status:403});
  now += TTL;
  assert.deepEqual(store.list(), []);
});

test("ordered retries are idempotent, drafts never become final, names apply to retained turns", () => {
  const store = new TranscriptStore(), session = store.create();
  const { token } = store.pair(session.pairCode,"A","ip");
  store.ingest(token,{seq:1,type:"draft",text:"How do"});
  assert.deepEqual(store.snapshot(session.id).turns, []);
  const packet = {seq:2,type:"final",text:"How do you scale?",speaker:"speaker-1",startedMs:0,endedMs:2100};
  store.ingest(token,packet); store.ingest(token,packet);
  assert.throws(() => store.ingest(token,{...packet,text:"changed"}),{status:409});
  store.rename(session.id,"speaker-1","Alex");
  const snapshot = store.snapshot(session.id);
  assert.equal(snapshot.turns.length,1); assert.equal(snapshot.draft,""); assert.equal(snapshot.names["speaker-1"],"Alex");
  assert.equal(store.snapshot(session.id,snapshot.version).turns.length,0);
});

test("raw audio, bad labels and oversized packets are rejected without consuming a sequence", () => {
  const store = new TranscriptStore(), session = store.create();
  const {token} = store.pair(session.pairCode,"A","ip");
  for (const packet of [{seq:1,type:"audio",audio:"abc"},{seq:1,type:"draft",text:"hi",spk:[1,2]},
    {seq:1,type:"draft",text:"x".repeat(4001)},{seq:1,type:"final",text:"hi",speaker:"owner",startedMs:0,endedMs:1}]) {
    assert.throws(() => store.ingest(token,packet),{status:400});
  }
  assert.equal(store.ingest(token,{seq:1,type:"status",state:"stopped"}).ackSeq,1);
});

test("microphone finals do not discard the remote speaker's current draft", () => {
  const store = new TranscriptStore(), session = store.create();
  const { token } = store.pair(session.pairCode,"Meeting","ip");
  store.ingest(token,{seq:1,type:"draft",channel:"meeting",text:"How would you design"});
  store.ingest(token,{seq:2,type:"draft",channel:"local",text:"let me think"});
  store.ingest(token,{seq:3,type:"final",channel:"local",speaker:"local",text:"let me think",startedMs:0,endedMs:1000});
  assert.equal(store.snapshot(session.id).draft,"How would you design");
  assert.equal(store.snapshot(session.id).turns[0].speaker,"local");
  store.ingest(token,{seq:4,type:"status",state:"stopped"});
  assert.equal(store.snapshot(session.id).draft,"");
});

test("history remains bounded and session capabilities cannot cross sessions", () => {
  const store = new TranscriptStore(), a = store.create(), b = store.create();
  const {token} = store.pair(a.pairCode,"A","ip");
  for (let seq=1;seq<=350;seq++) store.ingest(token,{seq,type:"final",text:`turn ${seq}`,speaker:"unknown",startedMs:0,endedMs:seq});
  assert.equal(store.snapshot(a.id).turns.length,300);
  assert.equal(store.snapshot(a.id).firstTurn,51);
  assert.equal(store.snapshot(b.id).turns.length,0);
});

test("real relay isolates transcript permissions from viewers and answer publishing", async t => {
  const child = spawn(process.execPath,[path.join(__dirname,"../server.js")],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PORT:"0",EDIT_KEY:"owner-test",STREAM_KEY:"publish-test",VIEW_KEY:"view-test",APP_PASSWORD:"",APP_ORIGIN:"",NODE_ENV:"test",RENDER:"",SMTP_HOST:"",SMTP_USER:"",SMTP_PASS:""}});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,"exit");child.kill();await done;}});
  const port = await new Promise((resolve,reject)=>{let text="";const timer=setTimeout(()=>reject(new Error("Startup timed out")),5000);child.stdout.on("data",chunk=>{text+=chunk;const match=text.match(/Server running on port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  const base=`http://127.0.0.1:${port}`;
  const post=(url,body,headers={})=>fetch(base+url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const owner={"X-Owner-Key":"owner-test"};
  assert.equal((await post("/api/transcripts/sessions",{action:"create"})).status,403);
  assert.equal((await post("/api/transcripts/sessions",{action:"create"},{...owner,Origin:"https://evil.example"})).status,403);
  const {session}=await (await post("/api/transcripts/sessions",{action:"create"},owner)).json();
  const {token}=await (await post("/api/transcripts/pair",{code:session.pairCode,name:"Meeting"})).json();
  assert.equal((await fetch(`${base}/api/transcripts/snapshot?id=${session.id}`,{headers:{"X-Owner-Key":"view-test"}})).status,403);
  assert.equal((await fetch(`${base}/api/transcripts/snapshot?id=${session.id}`,{headers:{Authorization:`Bearer ${token}`}})).status,403);
  assert.equal((await post("/answer",{key:token,text:"must not publish"})).status,403);
  assert.equal((await post("/api/transcripts/ingest",{seq:1,type:"final",text:"Question",speaker:"speaker-1",startedMs:0,endedMs:1000},{Authorization:`Bearer ${token}`})).status,200);
  const snapshot=await (await fetch(`${base}/api/transcripts/snapshot?id=${session.id}`,{headers:owner})).json();
  assert.equal(snapshot.turns[0].text,"Question");
  await post("/api/transcripts/sessions",{action:"end",id:session.id},owner);
  assert.equal((await post("/api/transcripts/ingest",{seq:2,type:"draft",text:"late"},{Authorization:`Bearer ${token}`})).status,403);
});
