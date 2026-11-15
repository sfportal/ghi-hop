import { streamSummary, fmtTime, NOTE_TYPES, buildPrompt } from "./prompts.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- Lưu trữ (IndexedDB, trên chính máy người dùng) ---------------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open("ghi-hop", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("meetings", { keyPath: "id" });
    r.result.createObjectStore("audio");
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (store, mode, fn) =>
  new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
const dbAll = () => tx("meetings", "readonly", (s) => s.getAll());
const dbGet = (id) => tx("meetings", "readonly", (s) => s.get(id));
const dbPut = (m) => tx("meetings", "readwrite", (s) => s.put(structuredClone(m)));
const dbDel = (id) => Promise.all([tx("meetings", "readwrite", (s) => s.delete(id)), tx("audio", "readwrite", (s) => s.delete(id))]);
const audioPut = (id, blob) => tx("audio", "readwrite", (s) => s.put(blob, id));
const audioGet = (id) => tx("audio", "readonly", (s) => s.get(id));

/* ---------------- Cài đặt ---------------- */
const settings = Object.assign({ key: "", pass: "", auto: "0", audio: true }, JSON.parse(localStorage.getItem("ghi-hop-settings") || "{}"));
const saveSettings = () => localStorage.setItem("ghi-hop-settings", JSON.stringify(settings));

let serverMode = false;
try {
  const r = await fetch("api/health", { cache: "no-store" });
  serverMode = r.ok && (await r.json()).server === true;
} catch {}
function renderMode() {
  const b = $("#modeBadge");
  if (serverMode) { b.textContent = "Máy chủ"; b.className = "badge ok"; }
  else if (settings.key) { b.textContent = "Demo · khóa trên máy"; b.className = "badge ok"; }
  else { b.textContent = "Chưa có khóa Claude"; b.className = "badge"; }
  $("#rowKey").hidden = serverMode;
  $("#rowPass").hidden = !serverMode;
  $("#settingsMode").textContent = serverMode
    ? "Đang chạy chế độ máy chủ: khóa Claude nằm trên Cloudflare, bạn không cần nhập."
    : "Đang chạy chế độ demo: tóm tắt gọi thẳng Claude API bằng khóa của bạn, khóa chỉ lưu trong trình duyệt này.";
}
renderMode();

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  const w = $("#supportWarn");
  w.hidden = false;
  w.textContent = "Trình duyệt này chưa hỗ trợ chép lời tiếng Việt trực tiếp. Hãy dùng Chrome hoặc Edge (máy tính, Android) hoặc Safari (iPhone). Bạn vẫn ghi âm và ghi chú được.";
}

/* ---------------- Trạng thái cuộc họp ---------------- */
let M = null; // cuộc họp đang mở
let rec = { on: false, paused: false, base: 0, since: 0, sr: null, mr: null, chunks: [], stream: null, wake: null, uttStart: null, timerId: 0, autoId: 0, saveId: 0 };
let noteType = "note";

const elapsed = () => rec.base + (rec.on && !rec.paused ? Date.now() - rec.since : 0);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function show(view) {
  $("#viewList").hidden = view !== "list";
  $("#viewMeeting").hidden = view !== "meeting";
}

/* ---------------- Danh sách ---------------- */
async function renderList() {
  const all = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
  const ul = $("#meetingList");
  ul.innerHTML = "";
  $("#emptyList").hidden = all.length > 0;
  for (const m of all) {
    const li = document.createElement("li");
    li.innerHTML = `<div><div class="t"></div><div class="muted small"></div></div><div class="muted small"></div>`;
    li.querySelector(".t").textContent = m.title || "Cuộc họp chưa đặt tên";
    li.children[0].children[1].textContent = new Date(m.createdAt).toLocaleString("vi-VN");
    li.children[1].textContent = `${fmtTime(m.durationMs || 0)} · ${m.notes.length} ghi chú${m.summary ? " · đã tóm tắt" : ""}`;
    li.onclick = () => openMeeting(m.id);
    ul.appendChild(li);
  }
}

async function newMeeting() {
  const d = new Date();
  M = { id: newId(), createdAt: Date.now(), startedAt: null, title: `Họp ngày ${d.toLocaleDateString("vi-VN")} ${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`, durationMs: 0, segments: [], notes: [], liveSummary: "", summary: "", hasAudio: false };
  await dbPut(M);
  await openMeeting(M.id);
}

async function openMeeting(id) {
  M = await dbGet(id);
  rec.base = M.durationMs || 0;
  $("#title").value = M.title;
  renderTranscript();
  renderNotes();
  renderSummary();
  await renderAudio();
  updateControls();
  setTab("transcript");
  show("meeting");
}

const persist = () => { if (M) { M.durationMs = elapsed(); return dbPut(M); } };

/* ---------------- Chép lời ---------------- */
function segEl(s, i) {
  const div = document.createElement("div");
  div.className = "seg" + (s.marked ? " marked" : "");
  div.innerHTML = `<span class="ts"></span><span class="txt" contenteditable="true" spellcheck="false"></span>`;
  div.querySelector(".ts").textContent = fmtTime(s.t);
  div.querySelector(".ts").onclick = () => seek(s.t);
  const txt = div.querySelector(".txt");
  txt.textContent = s.text;
  txt.onblur = () => { if (txt.textContent !== s.text) { s.text = txt.textContent.trim(); persist(); } };
  div.dataset.i = i;
  return div;
}
function renderTranscript() {
  const box = $("#transcript");
  box.innerHTML = "";
  M.segments.forEach((s, i) => box.appendChild(segEl(s, i)));
  if (!M.segments.length) box.innerHTML = `<p class="muted">Lời nói sẽ hiện ở đây khi bạn bấm “Bắt đầu ghi”.</p>`;
  $("#interim").textContent = "";
}
function addSegment(text, t) {
  text = text.trim();
  if (!text) return;
  if (!M.segments.length) $("#transcript").innerHTML = "";
  const s = { t, text };
  M.segments.push(s);
  $("#transcript").appendChild(segEl(s, M.segments.length - 1));
  if ($("#autoScroll").checked) $("#transcript").scrollTop = 1e9;
}

function startSR() {
  if (!SR) return;
  const sr = new SR();
  sr.lang = "vi-VN";
  sr.continuous = true;
  sr.interimResults = true;
  sr.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (rec.uttStart == null) rec.uttStart = elapsed();
      if (r.isFinal) {
        addSegment(r[0].transcript, rec.uttStart);
        rec.uttStart = null;
      } else interim += r[0].transcript;
    }
    $("#interim").textContent = interim;
  };
  sr.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      status("Trình duyệt chặn micro hoặc dịch vụ chép lời. Hãy cho phép micro rồi thử lại.");
      rec.sr = null;
    } else if (e.error !== "no-speech" && e.error !== "aborted") status(`Chép lời gián đoạn (${e.error}), đang nối lại…`);
  };
  // Chrome tự ngắt sau một lúc im lặng: tự khởi động lại khi còn đang ghi.
  sr.onend = () => {
    if (rec.on && !rec.paused && rec.sr === sr) setTimeout(() => { try { sr.start(); } catch {} }, 250);
  };
  rec.sr = sr;
  try { sr.start(); } catch {}
}
function stopSR() {
  const sr = rec.sr;
  rec.sr = null;
  try { sr?.stop(); } catch {}
  const pending = $("#interim").textContent;
  if (pending) addSegment(pending, rec.uttStart ?? elapsed());
  rec.uttStart = null;
  $("#interim").textContent = "";
}

/* ---------------- Ghi âm ---------------- */
async function startAudio() {
  if (!settings.audio || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
  try {
    if (!rec.stream) rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (!rec.mr) {
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
      rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
      rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
      rec.mr.start(5000);
    } else if (rec.mr.state === "paused") rec.mr.resume();
  } catch (err) {
    status("Không mở được micro để lưu file ghi âm (vẫn chép lời nếu được): " + err.message);
  }
}
async function saveAudio() {
  if (!rec.chunks.length) return;
  const blob = new Blob(rec.chunks, { type: rec.mr?.mimeType || "audio/webm" });
  await audioPut(M.id, blob);
  M.hasAudio = true;
}

/* ---------------- Điều khiển ghi ---------------- */
async function startRec() {
  if (!M.startedAt) M.startedAt = Date.now();
  rec.on = true; rec.paused = false; rec.since = Date.now();
  // Đã có bản ghi cũ: ghi tiếp sẽ nối thêm phần chép lời, file ghi âm cũ được thay bằng phần ghi mới.
  if (M.hasAudio && !rec.chunks.length) status("Ghi tiếp: lời nói được nối vào cuối, file ghi âm lưu phần ghi mới.");
  await startAudio();
  startSR();
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {}
  rec.timerId = setInterval(tick, 500);
  rec.saveId = setInterval(async () => { await saveAudio(); persist(); }, 30000);
  const mins = Number(settings.auto);
  if (mins) rec.autoId = setInterval(() => summarize("live"), mins * 60000);
  updateControls();
  if (!M.hasAudio || rec.chunks.length) status(SR ? "Đang nghe… Nói gần micro, mỗi câu sẽ hiện ra sau khi bạn ngừng một nhịp." : "Đang ghi âm (trình duyệt này không chép lời được).");
}
function pauseRec() {
  if (!rec.on) return;
  if (rec.paused) {
    rec.paused = false; rec.since = Date.now();
    if (rec.mr?.state === "paused") rec.mr.resume();
    startSR();
    status("Đang nghe…");
  } else {
    rec.base = elapsed(); rec.paused = true;
    stopSR();
    if (rec.mr?.state === "recording") rec.mr.pause();
    status("Đã tạm dừng.");
  }
  persist();
  updateControls();
}
async function stopRec() {
  if (!rec.on) return;
  rec.base = elapsed();
  rec.on = false; rec.paused = false;
  stopSR();
  clearInterval(rec.timerId); clearInterval(rec.saveId); clearInterval(rec.autoId);
  if (rec.mr && rec.mr.state !== "inactive") {
    await new Promise((r) => { rec.mr.onstop = r; rec.mr.stop(); });
  }
  rec.stream?.getTracks().forEach((t) => t.stop());
  await saveAudio();
  rec.mr = null; rec.stream = null; rec.chunks = [];
  try { await rec.wake?.release(); } catch {}
  await persist();
  await renderAudio();
  updateControls();
  tick();
  status("Đã kết thúc ghi. Bấm “Tóm tắt cuộc họp” để ra biên bản.");
  setTab("summary");
}
function tick() { $("#timer").textContent = fmtTime(elapsed()); }
function status(t) { $("#status").textContent = t; }
function updateControls() {
  tick();
  $("#btnRec").hidden = rec.on;
  $("#btnRec").textContent = M?.segments.length || M?.durationMs ? "● Ghi tiếp" : "● Bắt đầu ghi";
  $("#btnPause").hidden = !rec.on;
  $("#btnStop").hidden = !rec.on;
  $("#btnPause").textContent = rec.paused ? "▶ Tiếp tục" : "❚❚ Tạm dừng";
  $("#recDot").className = "dot" + (rec.on ? (rec.paused ? " paused" : " on") : "");
  $("#btnHome").disabled = rec.on;
}

/* ---------------- Ghi chú ---------------- */
function addNote(text, type = noteType, t = elapsed()) {
  text = text.trim();
  if (!text) return;
  M.notes.push({ id: newId(), t, type, text });
  M.notes.sort((a, b) => a.t - b.t);
  renderNotes();
  persist();
}
function renderNotes() {
  const ul = $("#notes");
  ul.innerHTML = "";
  for (const n of M.notes) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="ts"></span><span class="kind ${n.type}"></span><span class="body"></span><button class="x" title="Xóa">✕</button>`;
    li.querySelector(".ts").textContent = fmtTime(n.t);
    li.querySelector(".ts").onclick = () => seek(n.t);
    li.querySelector(".kind").textContent = NOTE_TYPES[n.type];
    li.querySelector(".body").textContent = n.text;
    li.querySelector(".x").onclick = () => { M.notes = M.notes.filter((x) => x.id !== n.id); renderNotes(); persist(); };
    ul.appendChild(li);
  }
  $("#noteCount").textContent = M.notes.length;
}
// Đánh dấu nhanh: lấy khoảng 20 giây lời nói gần nhất làm ghi chú "Quan trọng".
function markRecent() {
  const now = elapsed();
  const recent = M.segments.filter((s) => s.t >= now - 20000);
  const pick = recent.length ? recent : M.segments.slice(-1);
  pick.forEach((s) => (s.marked = true));
  const live = $("#interim").textContent.trim();
  const text = [...pick.map((s) => s.text), live].filter(Boolean).join(" ") || "(đánh dấu thời điểm này)";
  addNote(text, "important", pick[0]?.t ?? now);
  renderTranscript();
  status("Đã đánh dấu đoạn vừa nói là quan trọng.");
}

/* ---------------- Tổng hợp, tóm tắt ---------------- */
let busy = false;
async function summarize(mode) {
  if (busy) return;
  if (!M.segments.length && !M.notes.length) return status("Chưa có lời nói hay ghi chú để tổng hợp.");
  if (!serverMode && !settings.key) { status("Cần nhập khóa Claude API trong Cài đặt."); return $("#dlgSettings").showModal(); }
  busy = true;
  $("#btnLive").disabled = $("#btnSummarize").disabled = true;
  const box = mode === "live" ? $("#liveBox") : $("#summaryBox");
  let out = "";
  box.hidden = false; $("#summaryEmpty").hidden = true;
  box.innerHTML = `<p class="muted">${mode === "live" ? "Đang tổng hợp…" : "Đang viết biên bản…"}</p>`;
  if (mode === "final") setTab("summary");
  const input = { mode, title: M.title, startedAt: M.startedAt, segments: M.segments, notes: M.notes };
  const onText = (t) => { out += t; box.innerHTML = md(out); };
  try {
    if (serverMode) {
      const r = await fetch("api/summarize", { method: "POST", headers: { "content-type": "application/json", "x-app-passcode": settings.pass }, body: JSON.stringify(input) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const reader = r.body.getReader(); const dec = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; onText(dec.decode(value, { stream: true })); }
    } else {
      const { default: Anthropic } = await import("./vendor/anthropic-sdk.js");
      const client = new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true });
      await streamSummary(client, input, onText);
    }
    if (mode === "live") M.liveSummary = out; else M.summary = out;
    await persist();
    status(mode === "live" ? `Đã tổng hợp đến ${fmtTime(elapsed())}.` : "Đã có biên bản. Bạn có thể sao chép hoặc tải về.");
  } catch (e) {
    box.innerHTML = md(out + `\n\n> Lỗi: ${e.message || e}`);
  } finally {
    busy = false;
    $("#btnLive").disabled = $("#btnSummarize").disabled = false;
  }
}
function renderSummary() {
  $("#liveBox").hidden = !M.liveSummary; $("#liveBox").innerHTML = md(M.liveSummary || "");
  $("#summaryBox").hidden = !M.summary; $("#summaryBox").innerHTML = md(M.summary || "");
  $("#summaryEmpty").hidden = Boolean(M.liveSummary || M.summary);
}
function exportMd() {
  const head = `# ${M.title}\n\n${M.startedAt ? new Date(M.startedAt).toLocaleString("vi-VN") : ""} · Thời lượng ${fmtTime(M.durationMs)}\n\n`;
  const notes = M.notes.map((n) => `- [${fmtTime(n.t)}] **${NOTE_TYPES[n.type]}:** ${n.text}`).join("\n");
  const tr = M.segments.map((s) => `[${fmtTime(s.t)}] ${s.text}`).join("\n\n");
  return `${head}${M.summary || "_(chưa tóm tắt)_"}\n\n---\n\n## Ghi chú trong buổi họp\n\n${notes || "Không có"}\n\n---\n\n## Bản chép lời\n\n${tr || "Không có"}\n`;
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = () => (M.title || "cuoc-hop").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);

/* ---------------- Audio phát lại ---------------- */
async function renderAudio() {
  const p = $("#player");
  const blob = M.hasAudio ? await audioGet(M.id) : null;
  p.hidden = !blob; $("#btnAudio").hidden = !blob;
  if (blob) p.src = URL.createObjectURL(blob);
}
function seek(t) {
  const p = $("#player");
  if (p.hidden || rec.on) return;
  p.currentTime = t / 1000; p.play(); setTab("summary");
}

/* ---------------- Markdown tối giản ---------------- */
function md(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
  const lines = src.split("\n"); let html = ""; let list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); const lv = Math.min(4, m[1].length + 1); html += `<h${lv}>${inline(m[2])}</h${lv}>`; }
    else if (/^\s*\|.*\|\s*$/.test(l)) {
      close(); const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      html += "<table>" + body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("") + "</table>";
    }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^>\s?(.*)/))) { close(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (/^---+$/.test(l.trim())) { close(); html += "<hr>"; }
    else if (l.trim()) { close(); html += `<p>${inline(l)}</p>`; }
    else close();
  }
  close();
  return html;
}

/* ---------------- Tab trên điện thoại ---------------- */
function setTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("show", p.dataset.panel === name));
}

/* ---------------- Gắn sự kiện ---------------- */
$("#btnNew").onclick = newMeeting;
$("#btnHome").onclick = async () => { if (rec.on) return; await persist(); M = null; show("list"); renderList(); };
$("#btnRec").onclick = startRec;
$("#btnPause").onclick = pauseRec;
$("#btnStop").onclick = stopRec;
$("#title").oninput = () => { M.title = $("#title").value; persist(); };
$$("#tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$$("#noteTypes button").forEach((b) => (b.onclick = () => {
  noteType = b.dataset.type;
  $$("#noteTypes button").forEach((x) => x.classList.toggle("active", x === b));
  $("#noteInput").focus();
}));
$("#noteForm").onsubmit = (e) => { e.preventDefault(); addNote($("#noteInput").value); $("#noteInput").value = ""; };
$("#noteInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#noteForm").requestSubmit(); } };
$("#btnMark").onclick = markRecent;
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && M) { e.preventDefault(); markRecent(); } });
$("#btnLive").onclick = () => summarize("live");
$("#btnSummarize").onclick = () => summarize("final");
$("#btnCopy").onclick = async () => { await navigator.clipboard.writeText(exportMd()); status("Đã sao chép biên bản, ghi chú và bản chép lời."); };
$("#btnExport").onclick = () => download(`${safeName()}.md`, new Blob([exportMd()], { type: "text/markdown" }));
$("#btnAudio").onclick = async () => { const b = await audioGet(M.id); if (b) download(`${safeName()}.${b.type.includes("mp4") ? "m4a" : "webm"}`, b); };
$("#btnDelete").onclick = async () => {
  if (rec.on) return;
  if (!confirm("Xóa cuộc họp này cùng file ghi âm? Không khôi phục được.")) return;
  await dbDel(M.id); M = null; show("list"); renderList();
};
$("#btnSettings").onclick = () => {
  $("#setKey").value = settings.key; $("#setPass").value = settings.pass;
  $("#setAuto").value = settings.auto; $("#setAudio").checked = settings.audio;
  $("#dlgSettings").showModal();
};
$("#btnSaveSettings").onclick = () => {
  settings.key = $("#setKey").value.trim(); settings.pass = $("#setPass").value.trim();
  settings.auto = $("#setAuto").value; settings.audio = $("#setAudio").checked;
  saveSettings(); renderMode();
};
window.addEventListener("beforeunload", (e) => { if (rec.on) { persist(); e.preventDefault(); e.returnValue = ""; } });

/* ---------------- Cài đặt như ứng dụng (PWA) ---------------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("#btnInstall").hidden = false; });
$("#btnInstall").onclick = async () => { installEvt?.prompt(); installEvt = null; $("#btnInstall").hidden = true; };
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

// Cho kiểm thử tự động: bơm lời nói giả khi không có micro.
window.__ghiHop = { addSegment: (text) => addSegment(text, elapsed()), buildPrompt, get M() { return M; } };

show("list");
renderList();
