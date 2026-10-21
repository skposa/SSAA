const $ = s => document.querySelector(s);
const show = id => { document.querySelectorAll(".screen").forEach(s => s.classList.remove("on")); $(id).classList.add("on"); };
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("on"); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove("on"),2400); }
function bad(el){ el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }
function fmt(ts){ return new Date(ts).toLocaleString("ar", {dateStyle:"medium", timeStyle:"short"}); }

const TOKEN_KEY = "ssa_token_v2", CODE_KEY = "ssa_code_v2";
const FREE_FX = ["echo"]; // ← الميزات المجانية دائماً (يجب أن تطابق server.js)
let token = localStorage.getItem(TOKEN_KEY), me = null;

async function api(path, body){
  let r;
  try{
    r = await fetch("/api/" + path, {
      method: body !== undefined ? "POST" : "GET",
      headers: Object.assign({"Content-Type":"application/json"}, token ? {Authorization:"Bearer " + token} : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }catch(e){ const er = new Error("لا يوجد اتصال بالخادم"); er.status = 0; throw er; }
  let j = {}; try{ j = await r.json(); }catch(e){}
  if (!r.ok){ const er = new Error(j.message || j.error || "خطأ"); er.status = r.status; er.code = j.error; throw er; }
  return j;
}

async function checkCode(){
  const v = $("#codeIn").value.trim();
  try{
    await api("code", {code:v});
    sessionStorage.setItem(CODE_KEY, v);
    afterCode();
  }catch(e){
    $("#codeErr").textContent = e.message;
    bad($("#codePanel")); $("#codeIn").value = "";
  }
}
$("#codeBtn").onclick = checkCode;
$("#codeIn").addEventListener("keydown", e => { if (e.key === "Enter") checkCode(); });

async function afterCode(){
  if (token){
    try{ me = (await api("me")).me; route(); return; }
    catch(e){ if (e.status === 401){ token = null; localStorage.removeItem(TOKEN_KEY); } }
  }
  show("#s-auth");
}
function route(){
  if (me.role === "admin") return openAdmin();
  if (me.ban) return showBan();
  enterApp();
}

let mode = "login";
function setMode(m){
  mode = m;
  $("#tabLogin").classList.toggle("on", m==="login");
  $("#tabReg").classList.toggle("on", m==="reg");
  $("#confWrap").style.display = m==="reg" ? "block" : "none";
  $("#authBtn").textContent = m==="reg" ? "إنشاء الحساب" : "دخول";
  $("#authErr").textContent = "";
}
$("#tabLogin").onclick = () => setMode("login");
$("#tabReg").onclick = () => setMode("reg");

$("#authBtn").onclick = async () => {
  const name = $("#uName").value.trim(), pass = $("#uPass").value, err = $("#authErr");
  err.textContent = "";
  if (name.length < 3){ err.textContent = "اسم المستخدم 3 أحرف على الأقل"; return; }
  if (pass.length < 4){ err.textContent = "كلمة المرور 4 أحرف على الأقل"; return; }
  if (mode === "reg" && pass !== $("#uPass2").value){ err.textContent = "كلمتا المرور غير متطابقتين"; return; }
  $("#authBtn").disabled = true;
  try{
    const d = await api(mode === "reg" ? "register" : "login", {username:name, password:pass, code:sessionStorage.getItem(CODE_KEY)});
    token = d.token; localStorage.setItem(TOKEN_KEY, token); me = d.me;
    if (mode === "reg") toast("تم إنشاء حسابك وحفظ بياناتك");
    route();
  }catch(e){
    if (e.code === "code"){ sessionStorage.removeItem(CODE_KEY); show("#s-code"); }
    else { err.textContent = e.message; bad($("#s-auth .panel")); }
  }
  $("#authBtn").disabled = false;
};
["uName","uPass","uPass2"].forEach(i => $("#"+i).addEventListener("keydown", e => { if (e.key==="Enter") $("#authBtn").click(); }));

function localLogout(){
  stopMic();
  token = null; me = null; localStorage.removeItem(TOKEN_KEY);
  $("#uPass").value = ""; $("#uPass2").value = "";
  show("#s-auth");
}
async function logout(){ try{ await api("logout", {}); }catch(e){} localLogout(); }
$("#logoutBtn").onclick = logout; $("#adminOut").onclick = logout; $("#banOut").onclick = logout;

let ctx, stream, track, src, master, analyser, dest, effects = {}, active = {}, vol = 100;
let running = false, muted = false, raf, reacq = false, mutedTicks = 0, wake = null, fallbackOut = false;
const outEl = $("#outEl");

function enterApp(){
  $("#myId").textContent = me.id;
  $("#who").textContent = me.username;
  active = Object.assign({}, me.fx || {});
  vol = me.volume ?? 100;
  $("#vol").value = vol; $("#volVal").textContent = vol + "%";
  show("#s-app");
  applyFeatureLock();
}
function showBan(){
  stopMic();
  $("#banMsg").textContent = me.ban.permanent ? "تم حظر حسابك من التطبيق بشكل دائم." : "تم حظر حسابك حتى " + fmt(me.ban.until) + ".";
  show("#s-ban");
}
$("#copyId").onclick = async () => {
  const id = $("#myId").textContent;
  try{ await navigator.clipboard.writeText(id); }
  catch(e){ const t=document.createElement("textarea"); t.value=id; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("تم نسخ المعرّف " + id);
};

let st;
function saveSettings(){ clearTimeout(st); st = setTimeout(() => api("settings", {fx:active, volume:vol}).catch(()=>{}), 350); }

function makeCurve(k){ const n=44100, c=new Float32Array(n); for(let i=0;i<n;i++){ const x=i*2/n-1; c[i]=(3+k)*x*20*(Math.PI/180)/(Math.PI+k*Math.abs(x)); } return c; }

function buildEffects(){
  const mk = () => ({input:ctx.createGain(), output:ctx.createGain()});
  { const e=mk(), d=ctx.createDelay(2), fb=ctx.createGain(), wet=ctx.createGain();
    d.delayTime.value=.32; fb.gain.value=.55; wet.gain.value=.8;
    e.input.connect(e.output); e.input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(e.output); effects.echo=e; }
  { const e=mk(), hp=ctx.createBiquadFilter(), lp=ctx.createBiquadFilter(), pk=ctx.createBiquadFilter(), sh=ctx.createWaveShaper(), g=ctx.createGain();
    hp.type="highpass"; hp.frequency.value=550; lp.type="lowpass"; lp.frequency.value=3000;
    pk.type="peaking"; pk.frequency.value=1700; pk.gain.value=9; pk.Q.value=1.2; sh.curve=makeCurve(25); g.gain.value=1.3;
    e.input.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(sh); sh.connect(g); g.connect(e.output); effects.radio=e; }
  { const e=mk(), sh=ctx.createWaveShaper(), ring=ctx.createGain(), osc=ctx.createOscillator(), dry=ctx.createGain(), wet=ctx.createGain();
    sh.curve=makeCurve(120); ring.gain.value=0; osc.type="sawtooth"; osc.frequency.value=58; osc.connect(ring.gain); osc.start();
    dry.gain.value=.3; wet.gain.value=.9;
    e.input.connect(sh); sh.connect(ring); ring.connect(wet); wet.connect(e.output); e.input.connect(dry); dry.connect(e.output); effects.garble=e; }
  { const e=mk(), ls=ctx.createBiquadFilter(), pk=ctx.createBiquadFilter();
    ls.type="lowshelf"; ls.frequency.value=220; ls.gain.value=18; pk.type="peaking"; pk.frequency.value=90; pk.gain.value=10; pk.Q.value=1;
    e.input.connect(ls); ls.connect(pk); pk.connect(e.output); effects.bass=e; }
  { const e=mk(), up=ctx.createGain(), clip=ctx.createWaveShaper(), d1=ctx.createDelay(2), f1=ctx.createGain(), d2=ctx.createDelay(2), f2=ctx.createGain(), w=ctx.createGain();
    up.gain.value=3.2; clip.curve=makeCurve(8); w.gain.value=.75; d1.delayTime.value=.2; f1.gain.value=.6; d2.delayTime.value=.47; f2.gain.value=.5;
    e.input.connect(up); up.connect(clip); clip.connect(e.output);
    clip.connect(d1); d1.connect(f1); f1.connect(d1); d1.connect(w); clip.connect(d2); d2.connect(f2); f2.connect(d2); d2.connect(w); w.connect(e.output); effects.loud=e; }
}

// ← هل المستخدم يملك كل الميزات (فتح من الإدارة)؟
function featuresOn(){ return me && me.features !== false; }
// ← هل هذه الميزة مسموحة له؟ (echo مجاني، البقية تحتاج features)
function canUseFeature(k){ return FREE_FX.includes(k) || featuresOn(); }

function rewire(){
  if (!ctx) return;
  try{ src.disconnect(); }catch(e){}
  Object.values(effects).forEach(e => { try{ e.output.disconnect(); }catch(_){} });
  let prev = src;
  ["echo","radio","garble","bass","loud"].forEach(k => { if (active[k] && canUseFeature(k)){ prev.connect(effects[k].input); prev = effects[k].output; } });
  prev.connect(master);
}
function setStatus(){
  $("#status").textContent = muted ? "المايك مقفول" : "الميكروفون يعمل — صوتك يخرج من الهاتف";
}

// ← إصلاح الصدى: echoCancellation:true يكسر حلقة السماعة→المايك
function getStream(){
  return navigator.mediaDevices.getUserMedia({audio:{
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false
  }});
}
function attachTrack(){
  track.onended = () => setTimeout(reacquire, 300);
  track.onmute  = () => { if (running) $("#status").textContent = "تطبيق آخر يستخدم الميكروفون… جارٍ الاستعادة"; };
  track.onunmute= () => { if (ctx) ctx.resume().catch(()=>{}); setStatus(); };
}
async function reacquire(){
  if (!running || reacq) return;
  reacq = true;
  try{
    try{ track.onended = null; track.stop(); }catch(e){}
    stream = await getStream(); track = stream.getAudioTracks()[0];
    try{ src.disconnect(); }catch(e){}
    src = ctx.createMediaStreamSource(stream);
    track.enabled = !muted;
    rewire(); attachTrack(); setStatus();
  }catch(e){}
  reacq = false;
}
async function startMic(){
  if (running) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast("افتح الموقع عبر رابط https لتشغيل الميكروفون"); return; }
  try{ stream = await getStream(); }catch(e){ toast("لم يتم السماح باستخدام الميكروفون"); return; }
  try{ if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; }catch(e){}
  ctx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:"interactive"});
  await ctx.resume();
  track = stream.getAudioTracks()[0];
  src = ctx.createMediaStreamSource(stream);
  master = ctx.createGain(); master.gain.value = vol / 100;
  const lim = ctx.createDynamicsCompressor(); lim.threshold.value=-6; lim.ratio.value=12; lim.attack.value=.003; lim.release.value=.2;
  analyser = ctx.createAnalyser(); analyser.fftSize = 128;
  dest = ctx.createMediaStreamDestination();
  master.connect(lim); lim.connect(analyser); lim.connect(dest);
  outEl.srcObject = dest.stream;
  try{ await outEl.play(); fallbackOut = false; }catch(e){ lim.connect(ctx.destination); fallbackOut = true; }
  ctx.onstatechange = () => { if (running && ctx && ctx.state !== "running") ctx.resume().catch(()=>{}); };
  buildEffects(); rewire(); attachTrack();
  running = true; muted = false; mutedTicks = 0;
  $("#orb").className = "orb live";
  $("#startBtn").disabled = true; $("#muteBtn").disabled = false; $("#stopBtn").disabled = false;
  $("#muteBtn").textContent = "قفل المايك"; setStatus();
  try{ if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); }catch(e){}
  try{
    if ("mediaSession" in navigator){
      navigator.mediaSession.metadata = new MediaMetadata({title:"فِرْقَةُ SSA", artist:"الميكروفون يعمل"});
      navigator.mediaSession.playbackState = "playing";
      ["pause","stop"].forEach(a => { try{ navigator.mediaSession.setActionHandler(a, () => { outEl.play().catch(()=>{}); }); }catch(e){} });
    }
  }catch(e){}
  draw();
}
function stopMic(){
  cancelAnimationFrame(raf);
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (ctx){ try{ ctx.close(); }catch(e){} }
  try{ outEl.pause(); outEl.srcObject = null; }catch(e){}
  try{ if (wake) wake.release(); }catch(e){} wake = null;
  stream = ctx = track = src = master = analyser = dest = null; effects = {}; muted = false;
  $("#orb").className = "orb"; $("#status").textContent = "الميكروفون متوقف";
  $("#startBtn").disabled = false; $("#muteBtn").disabled = true; $("#stopBtn").disabled = true; $("#muteBtn").textContent = "قفل المايك";
  const c = $("#meter"); c.getContext("2d").clearRect(0,0,c.width,c.height);
}
function toggleMute(){
  if (!running) return;
  muted = !muted; track.enabled = !muted;
  $("#orb").className = "orb " + (muted ? "muted" : "live");
  $("#muteBtn").textContent = muted ? "فتح المايك" : "قفل المايك"; setStatus();
}
$("#startBtn").onclick = startMic; $("#stopBtn").onclick = stopMic; $("#muteBtn").onclick = toggleMute;

setInterval(() => {
  if (!running || !ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(()=>{});
  if (!fallbackOut && outEl.paused) outEl.play().catch(()=>{});
  if (track.readyState === "ended") { reacquire(); return; }
  if (track.muted && !muted){ if (++mutedTicks >= 3){ mutedTicks = 0; reacquire(); } } else mutedTicks = 0;
}, 1000);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !running) return;
  if (ctx) ctx.resume().catch(()=>{});
  try{ if (navigator.wakeLock && (!wake || wake.released)) wake = await navigator.wakeLock.request("screen"); }catch(e){}
  if (track && track.readyState === "ended") reacquire();
});

function draw(){
  const c = $("#meter"), g = c.getContext("2d"), data = new Uint8Array(analyser.frequencyBinCount);
  (function loop(){
    if (!analyser) return;
    analyser.getByteFrequencyData(data);
    g.clearRect(0,0,c.width,c.height);
    const n = data.length, w = c.width / n;
    for (let i=0;i<n;i++){ const h = Math.max(2,(data[i]/255)*c.height); g.fillStyle = `rgba(${196+(data[i]/6|0)},21,${63+i},.85)`; g.fillRect(i*w+1,(c.height-h)/2,w-2,h); }
    raf = requestAnimationFrame(loop);
  })();
}

function paintFx(){
  document.querySelectorAll(".fx").forEach(b => b.classList.toggle("on", !!active[b.dataset.fx] && canUseFeature(b.dataset.fx)));
}
function applyFeatureLock(){
  const on = featuresOn();
  $("#lockMsg").style.display = on ? "none" : "block";
  // كل زر: مقفول إذا كانت الميزة تحتاج صلاحية والمستخدم لا يملكها
  document.querySelectorAll(".fx").forEach(b => b.disabled = !canUseFeature(b.dataset.fx));
  // تنظيف: إذا كانت ميزة مدفوعة مفعّلة والمستخدم لا يملكها → نحذفها من active (نُبقي echo)
  let changed = false;
  Object.keys(active).forEach(k => { if (active[k] && !canUseFeature(k)) { delete active[k]; changed = true; } });
  paintFx();
  if (changed) rewire();
}
document.querySelectorAll(".fx").forEach(b => {
  b.onclick = () => {
    if (!canUseFeature(b.dataset.fx)) return;
    active[b.dataset.fx] = !active[b.dataset.fx];
    paintFx(); rewire(); saveSettings();
  };
});
$("#vol").addEventListener("input", e => {
  vol = Number(e.target.value); $("#volVal").textContent = vol + "%";
  if (master) master.gain.setTargetAtTime(vol / 100, ctx.currentTime, .02);
  saveSettings();
});

let shown = null;
function openAdmin(){ shown = null; show("#s-admin"); renderAdmin(); }
function renderAdmin(){
  $("#uCount").textContent = me && me.count != null ? me.count : 0;
  const card = $("#uCard");
  if (!shown){ card.style.display = "none"; return; }
  card.style.display = "block";
  $("#cName").textContent = shown.username; $("#cId").textContent = shown.id;
  const b = shown.ban, cb = $("#cBan");
  cb.className = "badge " + (b ? "bad" : "ok");
  cb.textContent = b ? (b.permanent ? "محظور دائمًا" : "محظور حتى " + fmt(b.until)) : "غير محظور";
  const cf = $("#cFeat");
  cf.className = "badge " + (shown.features ? "ok" : "bad");
  cf.textContent = shown.features ? "مفتوحة" : "مغلقة (التكرار فقط)";
}
async function searchUser(){
  const id = $("#sId").value.trim(); $("#sErr").textContent = "";
  if (!/^\d{5}$/.test(id)){ $("#sErr").textContent = "أدخل معرّفًا من 5 أرقام"; return; }
  try{ shown = (await api("admin/user?id=" + id)).user; renderAdmin(); }
  catch(e){ shown = null; renderAdmin(); $("#sErr").textContent = e.message; }
}
$("#sBtn").onclick = searchUser;
$("#sId").addEventListener("keydown", e => { if (e.key === "Enter") searchUser(); });
async function act(path, extra, msg){
  if (!shown) return;
  try{ shown = (await api("admin/" + path, Object.assign({id:shown.id}, extra || {}))).user; renderAdmin(); toast(msg); }
  catch(e){ toast(e.message); }
}
$("#bTemp").onclick = () => {
  const v = $("#banUntil").value, t = v ? new Date(v).getTime() : 0;
  if (!t || t <= Date.now()){ toast("اختر تاريخًا ووقتًا في المستقبل"); return; }
  act("ban", {until:t}, "تم حظر المستخدم مؤقتًا");
};
$("#bPerm").onclick  = () => act("ban", {permanent:true}, "تم الحظر الدائم");
$("#bUnban").onclick = () => act("unban", {}, "تم فتح الحظر");
$("#bOn").onclick    = () => act("features", {on:true}, "تم فتح جميع الميزات");
$("#bOff").onclick   = () => act("features", {on:false}, "تم غلق جميع الميزات (يبقى التكرار متاحاً)");

let syncing = false;
async function sync(){
  if (!token || !me || syncing) return;
  syncing = true;
  try{
    me = (await api("me")).me;
    if (me.role === "admin"){
      if ($("#s-admin").classList.contains("on")){
        if (shown){ try{ shown = (await api("admin/user?id=" + shown.id)).user; }catch(e){} }
        renderAdmin();
      }
    } else {
      const banScreen = $("#s-ban").classList.contains("on");
      if (me.ban && !banScreen) showBan();
      else if (!me.ban && banScreen){ enterApp(); toast("تم فتح الحظر عن حسابك"); }
      else if ($("#s-app").classList.contains("on")) applyFeatureLock();
    }
  }catch(e){ if (e.status === 401){ toast("انتهت الجلسة، سجّل الدخول من جديد"); localLogout(); } }
  syncing = false;
}
setInterval(sync, 1500);

if (sessionStorage.getItem(CODE_KEY)) afterCode(); else show("#s-code");
