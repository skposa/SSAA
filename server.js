const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT       = process.env.PORT || 3000;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
const ACCESS_CODE= process.env.ACCESS_CODE || "19.13.008.2";
const ADMIN_USER = (process.env.ADMIN_USER || "ssa_admin").toLowerCase();
const ADMIN_PASS = (process.env.ADMIN_PASS || "SSA@Admin#2026");
const DB_FILE = path.join(DATA_DIR, "db.json");
const FX_KEYS = ["echo", "radio", "garble", "bass", "loud"];
const FREE_FX = ["echo"]; // الميزات المجانية دائماً

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}

function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const hashPass = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function newId() {
  const used = new Set(Object.values(db.users).map(u => u.id));
  let id; do { id = String(Math.floor(10000 + Math.random() * 90000)); } while (used.has(id));
  return id;
}
function banState(u) {
  if (!u.ban) return null;
  if (u.ban.permanent) return { permanent: true };
  if (u.ban.until > Date.now()) return { until: u.ban.until };
  return null;
}
const view = u => ({ role: "user", username: u.username, id: u.id, features: u.features !== false, ban: banState(u), fx: u.fx || {}, volume: u.volume ?? 100 });
const adminView = u => ({ username: u.username, id: u.id, features: u.features !== false, ban: banState(u) });

const fails = new Map();
function limited(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() < f.t; }
function fail(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; f.n++; f.t = Date.now() + 10 * 60 * 1000; fails.set(ip, f); }
function ok(ip) { fails.delete(ip); }

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(resolve => {
    let s = ""; req.on("data", c => { s += c; if (s.length > 20000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { resolve({}); } });
  });
}
function auth(req) {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const s = db.sessions[t];
  if (!s) return null;
  if (s.role === "admin") return { token: t, role: "admin" };
  const u = db.users[s.key];
  return u ? { token: t, role: "user", key: s.key, user: u } : null;
}
function newSession(role, key) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = { role, key, created: Date.now() };
  return token;
}

async function api(req, res, url) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const route = url.pathname.replace("/api/", "");
  const b = req.method === "POST" ? await body(req) : {};

  if (route === "code") {
    if (limited(ip)) return send(res, 429, { error: "محاولات كثيرة، انتظر قليلاً" });
    if (String(b.code || "").trim() !== ACCESS_CODE) { fail(ip); return send(res, 403, { error: "الرمز غير صحيح" }); }
    ok(ip); return send(res, 200, { ok: true });
  }

  if (route === "register" || route === "login") {
    if (limited(ip)) return send(res, 429, { error: "محاولات كثيرة، انتظر قليلاً" });
    if (String(b.code || "").trim() !== ACCESS_CODE) return send(res, 403, { error: "code", message: "الرمز غير صحيح" });
    const name = String(b.username || "").trim(), pass = String(b.password || "");
    const key = name.toLowerCase();

    if (route === "register") {
      if (name.length < 3 || name.length > 20) return send(res, 400, { error: "اسم المستخدم من 3 إلى 20 حرفاً" });
      if (pass.length < 4 || pass.length > 100) return send(res, 400, { error: "كلمة المرور 4 أحرف على الأقل" });
      if (key === ADMIN_USER || db.users[key]) return send(res, 409, { error: "اسم المستخدم مستخدم من قبل" });
      const salt = crypto.randomBytes(16).toString("hex");
      // ← المستخدم الجديد: الميزات مغلقة افتراضياً (فقط التكرار مجاني)
      db.users[key] = { username: name, salt, pass: hashPass(pass, salt), id: newId(), features: false, ban: null, fx: {}, volume: 100, created: Date.now() };
      const token = newSession("user", key);
      save();
      return send(res, 200, { token, me: view(db.users[key]) });
    }

    if (key === ADMIN_USER) {
      if (!same(pass, ADMIN_PASS)) { fail(ip); return send(res, 401, { error: "بيانات الدخول غير صحيحة" }); }
      ok(ip); const token = newSession("admin", ADMIN_USER); save();
      return send(res, 200, { token, me: { role: "admin", username: name, count: Object.keys(db.users).length } });
    }
    const u = db.users[key];
    if (!u || !same(hashPass(pass, u.salt), u.pass)) { fail(ip); return send(res, 401, { error: "بيانات الدخول غير صحيحة" }); }
    ok(ip); const token = newSession("user", key); save();
    return send(res, 200, { token, me: view(u) });
  }

  const a = auth(req);
  if (!a) return send(res, 401, { error: "انتهت الجلسة" });

  if (route === "me") {
    if (a.role === "admin") return send(res, 200, { me: { role: "admin", username: ADMIN_USER, count: Object.keys(db.users).length } });
    return send(res, 200, { me: view(a.user) });
  }
  if (route === "logout") { delete db.sessions[a.token]; save(); return send(res, 200, { ok: true }); }

  if (route === "settings") {
    if (a.role !== "user") return send(res, 403, { error: "غير مسموح" });
    if (banState(a.user)) return send(res, 403, { error: "الحساب محظور" });
    // ← حفظ الإعدادات: مسموح فقط بالميزات المصرح بها (echo مجاني، والبقية تحتاج features)
    if (b.fx && typeof b.fx === "object") {
      const allowed = a.user.features !== false ? FX_KEYS : FREE_FX;
      a.user.fx = {};
      allowed.forEach(k => { if (b.fx[k] === true) a.user.fx[k] = true; });
    }
    if (typeof b.volume === "number" && isFinite(b.volume)) a.user.volume = Math.max(0, Math.min(1008, Math.round(b.volume)));
    save(); return send(res, 200, { ok: true });
  }

  if (route.startsWith("admin/")) {
    if (a.role !== "admin") return send(res, 403, { error: "للإدارة فقط" });
    const findById = id => Object.values(db.users).find(u => u.id === String(id));

    if (route === "admin/user") {
      const u = findById(url.searchParams.get("id"));
      return u ? send(res, 200, { user: adminView(u) }) : send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف" });
    }
    const u = findById(b.id);
    if (!u) return send(res, 404, { error: "لا يوجد مستخدم بهذا المعرّف" });

    if (route === "admin/ban") {
      if (b.permanent) u.ban = { permanent: true };
      else {
        const t = Number(b.until);
        if (!t || t <= Date.now()) return send(res, 400, { error: "اختر وقتاً في المستقبل" });
        u.ban = { permanent: false, until: t };
      }
    } else if (route === "admin/unban") u.ban = null;
    else if (route === "admin/features") {
      u.features = !!b.on;
      // ← عند غلق الميزات: نحافظ على echo (مجاني) ونمسح البقية
      if (!u.features) {
        const keepEcho = u.fx && u.fx.echo === true;
        u.fx = keepEcho ? { echo: true } : {};
      }
    } else return send(res, 404, { error: "غير موجود" });

    save(); return send(res, 200, { user: adminView(u) });
  }
  send(res, 404, { error: "غير موجود" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const STATIC = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"]
    };
    const f = STATIC[url.pathname];
    if (f) {
      res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return fs.createReadStream(path.join(__dirname, f[0])).pipe(res);
    }
    res.writeHead(404); res.end("404");
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: "خطأ في الخادم" }); }
});
server.listen(PORT, () => console.log("SSA يعمل على المنفذ " + PORT));
