(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let key = sessionStorage.getItem("lw-key") || "", gate = sessionStorage.getItem("lw-gate") || "";
  let session = "", cursor = 0, names = {}, turns = new Map(), timer, active = true, generation = 0, busy = false;
  let autoCopyEnabled = false, copyEpoch = 0, clipboardConnecting = false, receivedSnapshot = false, clipboardId = 0;
  let clipboardQueue = Promise.resolve();
  const clipboardRequests = new Map();
  const clipboardChannel = "lw-transcript-clipboard-v1";
  const notice = (text, error = false) => { $("notice").textContent = text; $("notice").classList.toggle("error", error); };
  async function api(path, body) {
    const response = await fetch(`/api/transcripts/${path}`, { method: body ? "POST" : "GET", cache:"no-store",
      headers:{ "Content-Type":"application/json", "X-Owner-Key":key, "X-Owner-Gate":gate }, ...(body ? { body:JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (response.status === 403) { logout(false); throw new Error("Enter your owner key and password to continue."); }
    if (!response.ok) throw new Error(data.error || "Could not load transcript. Try again.");
    return data;
  }
  function logout(clear = true) {
    receivedSnapshot = false; stopAutoCopy();
    generation++; clearTimeout(timer); session = ""; cursor = 0; turns.clear(); $("turns").replaceChildren();
    $("draft").textContent = ""; $("dashboard").hidden = true; $("login").hidden = false;
    names = {}; $("code").textContent = ""; $("sessions").replaceChildren(); $("speakerName").value = "";
    if (clear) { key = ""; gate = ""; ["lw-key","lw-gate","lw-role","lw-transcript-session"].forEach(k => sessionStorage.removeItem(k)); }
  }
  const speakerName = id => names[id] || (id === "unknown" ? "Unknown" : id === "local" ? "Meeting host" : `Speaker ${id.split("-")[1]}`);
  async function copy(text) { try { await navigator.clipboard.writeText(text); notice("Copied. Paste into ChatGPT when ready."); } catch { notice("Clipboard unavailable. Select the text and copy it manually.", true); } }
  function clipboardStatus(text, error = false) { $("clipboardStatus").textContent = text; $("clipboardStatus").classList.toggle("error", error); }
  function stopAutoCopy(message = "Auto-copy off. Click to copy new finished captions automatically.", error = false) {
    autoCopyEnabled = false; clipboardConnecting = false; copyEpoch++;
    $("autoCopy").textContent = "Auto-copy off"; $("autoCopy").setAttribute("aria-pressed", "false");
    $("autoCopy").disabled = !receivedSnapshot; clipboardStatus(message, error);
  }
  function clipboardRequest(operation, text) {
    return new Promise((resolve, reject) => {
      const id = ++clipboardId;
      const timeout = setTimeout(() => { clipboardRequests.delete(id); reject(new Error("Update Live Workspace to extension 5.4.2 or later, reload it, then refresh this page.")); }, 5000);
      clipboardRequests.set(id, {resolve,reject,timeout});
      window.postMessage({channel:clipboardChannel,direction:"request",id,operation,text}, location.origin);
    });
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== clipboardChannel || data.direction !== "response") return;
    const pending = clipboardRequests.get(data.id); if (!pending) return;
    clipboardRequests.delete(data.id); clearTimeout(pending.timeout);
    if (data.ok === true) pending.resolve(); else pending.reject(new Error(data.error || "Clipboard unavailable. Reload the extension and refresh this page."));
  });
  function autoCopyTurns(items) {
    if (!autoCopyEnabled || !items.length) return;
    const epoch = copyEpoch, current = generation;
    const text = items.map(turn => `${speakerName(turn.speaker)}: ${turn.text}`).join("\n\n");
    clipboardQueue = clipboardQueue.catch(() => {}).then(async () => {
      if (!autoCopyEnabled || epoch !== copyEpoch || current !== generation || !active) return;
      try {
        await clipboardRequest("copy", text);
        if (autoCopyEnabled && epoch === copyEpoch && current === generation) clipboardStatus("Copied finished captions. Paste into ChatGPT with Ctrl+V or Cmd+V.");
      } catch (error) { if (epoch === copyEpoch && current === generation) stopAutoCopy(error.message, true); }
    });
  }
  async function toggleAutoCopy() {
    if (autoCopyEnabled) { stopAutoCopy(); return; }
    if (clipboardConnecting || !receivedSnapshot) return;
    const current = generation, epoch = ++copyEpoch;
    clipboardConnecting = true; $("autoCopy").disabled = true; clipboardStatus("Connecting to the clipboard extension…");
    try {
      await clipboardRequest("check");
      if (current !== generation || epoch !== copyEpoch || !active) return;
      autoCopyEnabled = true; $("autoCopy").textContent = "Auto-copy on"; $("autoCopy").setAttribute("aria-pressed", "true");
      clipboardStatus("Auto-copy on. New finished captions will replace your clipboard, even while you use ChatGPT.");
      const latest = [...turns.values()].at(-1); if (latest) autoCopyTurns([latest]);
    } catch (error) { if (current === generation && epoch === copyEpoch) stopAutoCopy(error.message, true); }
    finally { if (current === generation) { clipboardConnecting = false; $("autoCopy").disabled = !receivedSnapshot; } }
  }
  function reset(id) { generation++; clearTimeout(timer); receivedSnapshot = false; stopAutoCopy(); session = id; cursor = 0; names = {}; turns.clear(); $("turns").replaceChildren(); $("draft").hidden = true; $("copyLatest").disabled = true; $("speakerName").value = ""; sessionStorage.setItem("lw-transcript-session", id); }
  function showSnapshot(data) {
    const freshTurns = data.turns.filter(turn => !turns.has(turn.id));
    names = data.names;
    const selected = $("sessions").selectedOptions[0];
    if (selected) selected.textContent = `${data.sender || "Waiting for sender"} · ${new Date(data.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
    const feed = $("turns"), follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    for (const turn of data.turns) turns.set(turn.id, turn);
    for (const id of turns.keys()) if (id < data.firstTurn) turns.delete(id);
    for (const node of [...feed.children]) if (!turns.has(Number(node.dataset.id))) node.remove();
    for (const turn of turns.values()) {
      let node = feed.querySelector(`[data-id="${turn.id}"]`);
      if (!node) {
        node = document.createElement("li"); node.className = "turn"; node.dataset.id = turn.id;
        const header = document.createElement("div"); header.className = "turn-header";
        const name = document.createElement("select"); name.className = "speaker";
        const time = document.createElement("time");
        const seconds = Math.floor(turn.startedMs / 1000); time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,"0")}`;
        name.setAttribute("aria-label", `Speaker for phrase at ${time.textContent}`);
        name.addEventListener("change", () => action(async () => { await api("sessions",{action:"assign",id:session,turnId:turn.id,speaker:name.value}); }));
        const button = document.createElement("button"); button.className = "secondary"; button.textContent = "Copy";
        button.addEventListener("click", () => { const current = turns.get(turn.id); if (current) copy(`${speakerName(current.speaker)}: ${current.text}`); });
        header.append(name,time,button); const p = document.createElement("p"); p.textContent = turn.text; node.append(header,p); feed.append(node);
      }
      const select = node.querySelector(".speaker");
      if (document.activeElement !== select) {
        select.replaceChildren();
        for (const id of ["unknown","local",...Array.from({length:8},(_,i)=>`speaker-${i+1}`)]) { const option = document.createElement("option"); option.value = id; option.textContent = speakerName(id); select.append(option); }
        select.value = turn.speaker;
      }
    }
    cursor = data.version;
    if (follow) feed.scrollTop = feed.scrollHeight;
    $("code").textContent = data.pairCode; $("pairing").hidden = !data.pairCode;
    $("draft").textContent = data.draft ? `Draft · ${data.draft}` : ""; $("draft").hidden = !data.draft;
    const stale = data.state === "listening" && data.lastSeen && Date.now() - data.lastSeen > 12000;
    $("connection").textContent = stale ? "Sender disconnected" : ({waiting:"Waiting for sender",ready:"Paired · ready",listening:`Listening · ${data.sender}`,stopped:"Sender stopped"}[data.state] || data.state);
    $("empty").hidden = turns.size > 0;
    $("empty").textContent = data.paired ? "Ready for speech. Final phrases appear here; drafts appear below." : "Enter the pairing code on the meeting computer, then choose Start captions.";
    $("copyLatest").disabled = turns.size === 0;
    receivedSnapshot = true; $("autoCopy").disabled = clipboardConnecting;
    autoCopyTurns(freshTurns);
  }
  async function poll() {
    const current = generation;
    if (!session || !active) return;
    try { const data = await api(`snapshot?id=${encodeURIComponent(session)}&after=${cursor}`); if (current !== generation) return; showSnapshot(data); notice("Only text is relayed. End this session to erase its transcript."); }
    catch(error) { if (current === generation) notice(error.message,true); }
    finally { if (current === generation && active) timer = setTimeout(poll, document.hidden ? 2000 : 500); }
  }
  async function load(preferred = "") {
    const current = generation;
    const data = await api("sessions"); if (current !== generation) return;
    sessionStorage.setItem("lw-key",key); if (gate) sessionStorage.setItem("lw-gate",gate);
    $("dashboard").hidden = false; $("login").hidden = true;
    $("sessions").replaceChildren();
    for (const row of data.sessions) { const option = document.createElement("option"); option.value = row.id; option.textContent = `${row.sender || "Waiting for sender"} · ${new Date(row.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`; $("sessions").append(option); }
    const id = [preferred,sessionStorage.getItem("lw-transcript-session"),data.sessions.at(-1)?.id].find(id => data.sessions.some(row => row.id === id)) || "";
    reset(id); $("sessions").value = id; $("end").disabled = !id; $("saveName").disabled = !id; $("pairing").hidden = true;
    if (id) poll(); else notice("Create a session to connect the meeting computer.");
  }
  async function action(task) { if (busy) return; busy = true; try { await task(); } catch(error) { notice(error.message,true); } finally { busy = false; } }
  $("login").addEventListener("submit", event => { event.preventDefault(); action(async () => {
    key = $("key").value.trim(); gate = "";
    if ($("password").value) { const response = await fetch("/api/unlock", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("password").value})}); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Check the workspace password."); gate = data.token || ""; }
    $("password").value = ""; $("key").value = ""; await load();
  }); });
  $("create").addEventListener("click", () => action(async () => { const data = await api("sessions",{action:"create"}); await load(data.session.id); }));
  $("end").addEventListener("click", () => action(async () => { if (session) await api("sessions",{action:"end",id:session}); await load(); }));
  $("sessions").addEventListener("change", () => { reset($("sessions").value); poll(); });
  $("copyCode").addEventListener("click", () => copy($("code").textContent));
  $("copyLatest").addEventListener("click", () => { const turn = [...turns.values()].at(-1); if (turn) copy(`${speakerName(turn.speaker)}: ${turn.text}`); });
  $("autoCopy").addEventListener("click", toggleAutoCopy);
  $("speaker").addEventListener("change", () => { $("speakerName").value = names[$("speaker").value] || ""; });
  const localOption = document.createElement("option"); localOption.value = "local"; localOption.textContent = "Meeting host"; $("speaker").append(localOption);
  $("rename").addEventListener("submit", event => { event.preventDefault(); action(async () => { await api("sessions",{action:"rename",id:session,speaker:$("speaker").value,name:$("speakerName").value}); notice("Speaker name saved."); }); });
  $("signout").addEventListener("click", () => { logout(); notice("Signed out in this tab. Existing sessions still expire after 2 hours."); });
  window.addEventListener("pagehide", () => { active = false; clearTimeout(timer); stopAutoCopy(); });
  if (key) load().catch(error => notice(error.message,true)); else { logout(false); notice("Use your owner key to receive meeting captions."); }
})();
