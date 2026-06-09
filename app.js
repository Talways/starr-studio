/* STARR Studio — минимальная версия: сценарий → запись с суфлёром → сохранить */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const screens = { script:$("screen-script"), record:$("screen-record"), result:$("screen-result") };
function show(name){ const p=document.getElementById("proc"); if(p)p.classList.add("hidden"); Object.values(screens).forEach(s=>s.classList.remove("active")); screens[name].classList.add("active"); }

const state = {
  stream:null, facing:"user", mirror:true,
  recording:false, paused:false, recorder:null, segments:[], _takeRes:null,
  recMime:"", recType:"video/mp4",
  recStart:0, pausedAccum:0, pauseStart:0, raf:null,
  // суфлёр
  teleRaf:null, telePxPerMs:0, teleScrollPos:0, telePrevTs:0, teleManual:false, teleManualUntil:0, teleDurMs:0,
  blobUrl:null, file:null,
};

// сохраняем сценарий между запусками
$("script").value = localStorage.getItem("script") || "";
$("script").addEventListener("input", () => localStorage.setItem("script", $("script").value));

// ---------- Переход к записи ----------
$("to-record").onclick = async () => {
  $("tele-text").textContent = ($("script").value || "").trim();
  show("record");
  await startCamera();
  resetTele();
};
$("btn-back").onclick = () => { stopCamera(); stopTele(); show("script"); };

// ---------- Камера ----------
function applyMirror(){ $("cam").classList.toggle("mirror", state.mirror && state.facing==="user"); }
function camMsg(text){ const b=$("cam-msg"); if(!text){ b.classList.add("hidden"); return; } b.textContent=text; b.classList.remove("hidden"); }
async function startCamera(){
  stopCamera();
  camMsg("");
  const cam = $("cam");
  // простые constraints + фолбэк (тяжёлые размеры на некоторых фронталках ломают видео)
  let stream = null, err = null;
  for (const c of [ { video:{facingMode:state.facing}, audio:true }, { video:true, audio:true }, { video:true, audio:false } ]){
    try{ stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch(e){ err = e; }
  }
  if (!stream){ camMsg("Камера недоступна: " + (err && (err.name||err.message) || "ошибка") + "\nНажми, чтобы повторить"); return; }
  state.stream = stream;
  cam.srcObject = stream; cam.muted = true; cam.playsInline = true;
  applyMirror();
  try{ await cam.play(); }
  catch(e){ camMsg("Нажми, чтобы включить камеру ▶"); return; }
  // проверка, что видео реально идёт
  const vt = stream.getVideoTracks()[0];
  if (!vt || vt.readyState !== "live"){ camMsg("Видео с камеры не запустилось. Нажми, чтобы повторить."); }
}
// тап по сообщению — повторить запуск/проигрывание (это пользовательский жест, iOS любит жесты)
$("cam-msg").onclick = async () => {
  camMsg("");
  const cam = $("cam");
  if (state.stream && state.stream.getVideoTracks().length){
    try{ await cam.play(); applyMirror(); return; }catch(e){}
  }
  await startCamera();
};
function stopCamera(){ if (state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; } }
$("btn-flip").onclick = async () => { state.facing = state.facing==="user"?"environment":"user"; await startCamera(); };

// ---------- Суфлёр (авто + ручной скролл) ----------
function estSeconds(text, speed){ const n=(text||"").trim().split(/\s+/).filter(Boolean).length; return Math.max(4, n/(2.3*speed)); }
function resetTele(){ $("teleprompter").scrollTop = 0; }
function runTele(durationMs){
  const el = $("teleprompter");
  el.scrollTop = 0;
  const dist = Math.max(1, el.scrollHeight - el.clientHeight);
  state.telePxPerMs = dist / Math.max(1500, durationMs);
  state.teleManual=false; state.teleManualUntil=0; state.telePrevTs=0; state.teleScrollPos=0;
  cancelAnimationFrame(state.teleRaf);
  const tick = (ts) => {
    if (!state.telePrevTs) state.telePrevTs = ts;
    const dt = ts - state.telePrevTs; state.telePrevTs = ts;
    const manual = state.teleManual || ts < state.teleManualUntil;
    if (state.recording && !state.paused && !manual){
      const max = el.scrollHeight - el.clientHeight;
      state.teleScrollPos = Math.min(max, state.teleScrollPos + state.telePxPerMs*dt);
      el.scrollTop = Math.round(state.teleScrollPos);
    }
    state.teleRaf = requestAnimationFrame(tick);
  };
  state.teleRaf = requestAnimationFrame(tick);
}
function stopTele(){ cancelAnimationFrame(state.teleRaf); state.teleRaf=null; }
(function initTeleTouch(){
  const el = $("teleprompter");
  el.addEventListener("touchstart", ()=>{ state.teleManual=true; }, {passive:true});
  const release = ()=>{ state.teleManual=false; state.teleManualUntil=performance.now()+1500; state.teleScrollPos=el.scrollTop; };
  el.addEventListener("touchend", release, {passive:true});
  el.addEventListener("touchcancel", release, {passive:true});
  el.addEventListener("wheel", ()=>{ state.teleManualUntil=performance.now()+1500; state.teleScrollPos=el.scrollTop; }, {passive:true});
})();
$("speed").oninput = () => {
  if (state.recording){
    const el = $("teleprompter");
    const dist = Math.max(1, el.scrollHeight - el.clientHeight);
    state.telePxPerMs = dist / Math.max(1500, estSeconds($("tele-text").textContent, parseFloat($("speed").value))*1000);
  }
};

// ---------- Запись (посегментно: дубль = сегмент) ----------
function pickMime(){
  const c = ['video/mp4;codecs="avc1.640028,mp4a.40.2"','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
  for (const m of c) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
function drawCover(ctx, video, W, H, mirror){
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh){ return; }
  const scale = Math.max(W/vw, H/vh);
  const dw = vw*scale, dh = vh*scale, dx = (W-dw)/2, dy = (H-dh)/2;
  ctx.save();
  if (mirror){ ctx.translate(W,0); ctx.scale(-1,1); }
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.restore();
}
function startTake(){
  state.curChunks = [];
  state._takeFlushed = false;
  let r;
  try{ r = new MediaRecorder(state.recStream, state.recMime ? { mimeType:state.recMime, videoBitsPerSecond:10_000_000 } : undefined); }
  catch(e){ alert("Запись не поддерживается: "+(e.message||e)); return; }
  r.ondataavailable = e => { if (e.data && e.data.size) state.curChunks.push(e.data); };
  r.onstop = () => flushTake();
  r.start(100); state.recorder = r;
}
function flushTake(){
  if (state._takeFlushed) return;
  state._takeFlushed = true;
  if (state.curChunks && state.curChunks.length) state.segments.push(new Blob(state.curChunks, { type: state.recType }));
  const res = state._takeRes; state._takeRes = null; if (res) res();
}
function stopTake(){
  return new Promise(res=>{
    const r = state.recorder;
    if (!r || r.state === "inactive"){ res(); return; }
    state._takeFlushed = false; state._takeRes = res;
    try{ r.requestData(); }catch(e){}     // вытолкнуть данные сразу
    try{ r.stop(); }catch(e){}
    setTimeout(flushTake, 3500);          // страховка: собрать из буфера, даже если событие stop не пришло (iOS)
  });
}
function showProc(msg){ $("proc-msg").textContent = msg||"Собираю видео…"; $("proc").classList.remove("hidden"); }
function hideProc(){ $("proc").classList.add("hidden"); }

$("btn-record").onclick = async () => {
  if (state.recording){ await stopRecording(); return; }
  await countdown(3);
  startRecording();
};
function countdown(n){
  return new Promise(res=>{ const el=$("countdown"); el.classList.remove("hidden"); let i=n; el.textContent=i;
    const t=setInterval(()=>{ i--; if(i<=0){clearInterval(t); el.classList.add("hidden"); res();} else el.textContent=i; },1000); });
}
function startRecording(){
  if (!state.stream){ alert("Камера не готова"); return; }
  state.recMime = pickMime();
  state.recType = (state.recMime && state.recMime.startsWith("video/mp4")) ? "video/mp4" : "video/webm";
  // canvas-композит: вертикаль 1080×1920 + зеркало фронталки
  const W = 1080, H = 1920;
  state.W = W; state.H = H;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  state.recCanvas = canvas; state.recCtx = ctx;
  const audioTracks = state.stream.getAudioTracks();
  state.recStream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioTracks]);

  state.segments = [];
  state.recording = true; state.paused = false;
  state.recStart = performance.now(); state.pausedAccum = 0; state.pauseStart = 0;
  startTake();
  $("btn-record").classList.add("recording");
  $("btn-pause").classList.remove("hidden"); $("btn-pause").textContent="⏸";
  $("btn-discard").classList.add("hidden");
  $("btn-back").classList.add("hidden"); $("btn-flip").classList.add("hidden");
  runTele(estSeconds($("tele-text").textContent, parseFloat($("speed").value))*1000);
  const cam = $("cam");
  const tick = () => {
    const mirror = state.mirror && state.facing === "user";
    ctx.clearRect(0,0,W,H);
    drawCover(ctx, cam, W, H, mirror);
    const active = state.paused ? (state.pauseStart-state.recStart-state.pausedAccum) : (performance.now()-state.recStart-state.pausedAccum);
    $("rec-timer").textContent = fmtTime(Math.max(0, active/1000));
    if (state.recording) state.raf = requestAnimationFrame(tick);
  };
  tick();
}
$("btn-pause").onclick = async () => {
  if (!state.recording) return;
  if (state.paused){
    state.pausedAccum += performance.now() - state.pauseStart;
    state.paused = false; startTake();
    $("btn-pause").textContent="⏸"; $("btn-discard").classList.add("hidden");
    $("btn-record").classList.add("recording"); state.telePrevTs = 0;
  } else {
    state.paused = true; state.pauseStart = performance.now();
    $("btn-pause").textContent="▶"; $("btn-record").classList.remove("recording");
    $("btn-pause").disabled = true; await stopTake(); $("btn-pause").disabled = false;
    if (state.segments.length){ $("btn-discard").textContent="↩︎ Сбросить дубль"; $("btn-discard").classList.remove("hidden"); }
  }
};
$("btn-discard").onclick = () => {
  if (!state.paused) return;
  if (state.segments.length) state.segments.pop();
  const b=$("btn-discard"); b.textContent="✓ Дубль сброшен — продолжай"; setTimeout(()=>b.classList.add("hidden"),1100);
};
async function stopRecording(){
  if (!state.recording) return;
  state.recording = false; stopTele(); cancelAnimationFrame(state.raf);
  $("btn-record").classList.remove("recording");
  $("btn-pause").classList.add("hidden"); $("btn-discard").classList.add("hidden");
  $("btn-back").classList.remove("hidden"); $("btn-flip").classList.remove("hidden");
  showProc("Собираю видео…");           // мгновенный индикатор, чтобы не было «ничего не происходит»
  try{
    if (!state.paused) await stopTake();
    state.paused = false;
    await finalize();
  }catch(e){
    console.error("finalize:", e);
    hideProc();
    alert("Не удалось собрать видео: " + (e.message||e));
  }
}

// ---------- Склейка дублей (если их несколько) ----------
function attachOffscreen(el){ el.playsInline=true; el.setAttribute("playsinline",""); el.style.cssText="position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1"; document.body.appendChild(el); }
async function flattenSegments(segs){
  // размеры из первого сегмента
  const probe = document.createElement("video"); probe.src = URL.createObjectURL(segs[0]); attachOffscreen(probe);
  await new Promise(r=>{ probe.onloadedmetadata=r; probe.onerror=r; });
  const W = probe.videoWidth||1080, H = probe.videoHeight||1920;
  probe.remove();
  const canvas = document.createElement("canvas"); canvas.width=W; canvas.height=H; const ctx=canvas.getContext("2d");
  const AC = window.AudioContext||window.webkitAudioContext; const actx=new AC(); try{await actx.resume();}catch(e){}
  const dest = actx.createMediaStreamDestination();
  const mixed = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(mixed, state.recMime?{mimeType:state.recMime,videoBitsPerSecond:8_000_000}:undefined);
  const chunks=[]; rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);}; const done=new Promise(r=>rec.onstop=r);
  let started=false, i=0;
  for (const seg of segs){
    const url=URL.createObjectURL(seg); const v=document.createElement("video"); v.src=url; v.muted=false; v.playsInline=true; attachOffscreen(v);
    // ждём метаданные (с таймаутом 5с, чтобы не зависнуть на битом куске)
    const okMeta = await new Promise(r=>{ let done=false; const fin=ok=>{ if(done)return; done=true; r(ok); };
      v.onloadedmetadata=()=>fin(true); v.onerror=()=>fin(false); setTimeout(()=>fin(false), 5000); });
    if (!okMeta){ v.remove(); URL.revokeObjectURL(url); i++; setProc(i/segs.length*100); continue; }
    try{ const node=actx.createMediaElementSource(v); node.connect(dest); }catch(e){}
    try{ await v.play(); }catch(e){}
    try{ ctx.drawImage(v,0,0,W,H); }catch(e){}
    if (!started){ rec.start(100); started=true; }
    let raf;
    const maxMs = ((isFinite(v.duration)&&v.duration>0)? v.duration*1000 + 2000 : 180000); // страховка от зависона
    const segDone=new Promise(res=>{
      let fin=false; const stop=()=>{ if(fin)return; fin=true; cancelAnimationFrame(raf); res(); };
      v.onended=stop; v.onerror=stop; setTimeout(stop, maxMs);
    });
    const fr=()=>{ try{ctx.drawImage(v,0,0,W,H);}catch(e){} raf=requestAnimationFrame(fr); }; fr();
    await segDone; try{ v.pause(); }catch(e){} v.remove(); URL.revokeObjectURL(url);
    i++; setProc(i/segs.length*100);
  }
  if (started){ rec.stop(); await done; } else { try{rec.stop()}catch(e){} }
  try{actx.close();}catch(e){}
  return new Blob(chunks,{type:state.recType});
}

// ---------- Финал ----------
function fmtTime(s){ const m=Math.floor(s/60), ss=Math.floor(s%60); return `${m}:${ss<10?"0":""}${ss}`; }
function setProc(p){ $("proc-msg").textContent = "Склеиваю дубли… " + Math.round(p) + "%"; }
async function finalize(){
  stopCamera();
  const segs = state.segments || [];
  if (!segs.length){ hideProc(); alert("Запись пустая (дубль не записался)."); show("script"); return; }
  let raw;
  if (segs.length > 1) showProc("Склеиваю дубли…");
  try{ raw = (segs.length===1) ? segs[0] : await flattenSegments(segs); }
  catch(e){ console.warn("flatten:", e); raw = segs[segs.length-1]; }
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blobUrl = URL.createObjectURL(raw);
  const ext = state.recType==="video/mp4" ? "mp4" : "webm";
  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  state.file = new File([raw], `starr-${ts}.${ext}`, { type: state.recType });
  $("result-video").src = state.blobUrl;
  const canShare = navigator.canShare && navigator.canShare({ files:[state.file] });
  $("result-note").textContent = canShare
    ? "Нажми «Сохранить / Поделиться» → «Сохранить видео» (в Фото) или Instagram."
    : (ext==="webm" ? "Скачается WebM — на компьютере сконвертируй в MP4." : "Скачается MP4 — готов для Instagram. Либо зажми видео выше → «Сохранить».");
  show("result");
}
async function saveVideo(){
  if (!state.file) return;
  const canShare = navigator.canShare && navigator.canShare({ files:[state.file] });
  if (canShare){ try{ await navigator.share({ files:[state.file], title:"STARR Reel" }); return; }catch(e){ if(e&&e.name==="AbortError") return; } }
  const a=document.createElement("a"); a.href=state.blobUrl; a.download=state.file.name; document.body.appendChild(a); a.click(); a.remove();
}
$("btn-save").onclick = saveVideo;
$("btn-new").onclick = () => { show("script"); };

window.__min = { state, startRecording, stopRecording, get finalize(){return finalize;} };
})();
