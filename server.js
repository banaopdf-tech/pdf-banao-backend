// PDF Banao — backend conversion service
// Handles the tools that genuinely need server-side software:
//   Office (Word/PowerPoint/Excel) <-> PDF   — via LibreOffice headless
//   Unlock PDF / Protect PDF                  — via qpdf
// and the site's traffic statistics for the admin panel (see the bottom).
//
// Everything else in PDF Banao runs client-side in the browser; this
// service exists only for the handful of tools that need real desktop
// software to do correctly (no "rename the extension" fakes).

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(cors());

/* health counters for the admin panel, in memory only (reset on restart).
   Never holds query strings, bodies, headers, tokens, IPs or emails. */
const health = {
  startTime: Date.now(), requestsTotal: 0, routes: {}, errorsRecent: [],
  payments: { order_ok: 0, order_fail: 0, verify_ok: 0, verify_fail: 0, recent: [] },
};
const pushCapped = (list, item, max) => { list.push(item); if (list.length > max) list.splice(0, list.length - max); };
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    try {
      // matched routes use their pattern (/convert/from-pdf/:target); anything
      // else its bare path, with a cap so scanners cannot grow the map forever
      let route = String((req.route && req.route.path) || req.path || "?").slice(0, 100);
      if (!health.routes[route] && Object.keys(health.routes).length >= 200) route = "(other)";
      const e = health.routes[route] || (health.routes[route] = { count: 0, errors: 0, slow: 0 });
      health.requestsTotal++;
      e.count++;
      if (res.statusCode >= 500) {
        e.errors++;
        pushCapped(health.errorsRecent, { ts: Date.now(), route, message: (res.statusCode + " " + route).slice(0, 200) }, 20);
      }
      if (Date.now() - start > 2000) e.slow++;
    } catch (err) {}
  });
  next();
});
/* a payment step that failed; reason is always a short fixed label */
function payFail(stage, reason) {
  if (stage === "order") health.payments.order_fail++; else health.payments.verify_fail++;
  pushCapped(health.payments.recent, { ts: Date.now(), stage, reason: String(reason).slice(0, 200) }, 10);
}
/* a payment step that succeeded */
function payOk(stage) {
  if (stage === "order") health.payments.order_ok++; else health.payments.verify_ok++;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — generous for office docs, keeps free-tier memory safe
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_FILE_BYTES } });

function newWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
}
function cleanup(dir, uploadedPath) {
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  try { if (uploadedPath) fs.unlinkSync(uploadedPath); } catch (e) {}
}
function safeExt(name) {
  return (path.extname(name || "") || "").replace(/[^.\w]/g, "").toLowerCase();
}

// Run a single LibreOffice headless conversion. LibreOffice can only run
// one instance per user profile at a time reliably, so we give each job
// its own isolated profile dir (-env:UserInstallation) to allow safe
// concurrent requests without them corrupting each other's state.
// `infilter` is required for PDF -> editable-document conversions: without
// it, LibreOffice opens a PDF as a flat Draw document and the export
// silently fails, so callers must pass the right importer for the target
// (Writer for docx, Impress for pptx — Calc has no working PDF importer).
function convertWithLibreOffice(inputPath, outputDir, targetFormat, infilter) {
  return new Promise((resolve, reject) => {
    const profileDir = newWorkDir("lo-profile");
    const args = [
      "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
      `-env:UserInstallation=file://${profileDir}`,
    ];
    if (infilter) args.push(`--infilter=${infilter}`);
    args.push("--convert-to", targetFormat, "--outdir", outputDir, inputPath);
    execFile("soffice", args, { timeout: 90000 }, (err, stdout, stderr) => {
      cleanup(profileDir, null);
      if (err) return reject(new Error("Conversion failed (LibreOffice): " + (stderr || err.message).slice(0, 300)));
      resolve(stdout);
    });
  });
}

app.get("/", (req, res) => res.json({ status: "ok", service: "PDF Banao backend" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---- Office document -> PDF (Word/PowerPoint/Excel/Text/RTF -> PDF) ----
app.post("/convert/to-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const allowedExt = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".txt", ".odt", ".odp", ".ods"];
  const ext = safeExt(req.file.originalname);
  if (!allowedExt.includes(ext)) {
    cleanup(null, req.file.path);
    return res.status(400).json({ error: `Unsupported file type "${ext}". Supported: Word, PowerPoint, Excel, RTF, TXT, ODT/ODP/ODS.` });
  }
  const workDir = newWorkDir("to-pdf");
  try {
    const inputPath = path.join(workDir, "input" + ext);
    fs.copyFileSync(req.file.path, inputPath);
    await convertWithLibreOffice(inputPath, workDir, "pdf");
    const outputPath = path.join(workDir, "input.pdf");
    if (!fs.existsSync(outputPath)) throw new Error("Conversion did not produce a PDF.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
    fs.createReadStream(outputPath).pipe(res).on("close", () => cleanup(workDir, req.file.path));
  } catch (err) {
    cleanup(workDir, req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ---- PDF -> Office document / eBook (Word, PowerPoint, RTF, EPUB) ----
// NOTE: PDF -> Excel is intentionally not offered. LibreOffice has no
// working PDF-to-Calc importer (verified: the only candidate filter,
// calc_pdf_addstream_import, fails to even load the source file) — Excel
// has no concept of "cells" to reconstruct from a PDF's page layout the
// way Writer/Impress can reconstruct paragraphs/slides. Rather than ship
// a silently-broken conversion, this target is left unsupported.
const PDF_TARGETS = {
  word: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", infilter: "writer_pdf_import" },
  powerpoint: { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", infilter: "impress_pdf_import" },
  // RTF and EPUB come out of the same Writer pipeline as docx: the PDF is
  // imported with writer_pdf_import and then written back out through a
  // different Writer export filter. Both filters ship with the
  // libreoffice-writer package already in the Dockerfile, so this needs no
  // new dependency and no larger image.
  rtf: { ext: "rtf", mime: "application/rtf", infilter: "writer_pdf_import" },
  epub: { ext: "epub", mime: "application/epub+zip", infilter: "writer_pdf_import" },
};
app.post("/convert/from-pdf/:target", upload.single("file"), async (req, res) => {
  const target = PDF_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ error: "Unsupported target format" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (safeExt(req.file.originalname) !== ".pdf") {
    cleanup(null, req.file.path);
    return res.status(400).json({ error: "Please upload a PDF file." });
  }
  const workDir = newWorkDir("from-pdf");
  try {
    const inputPath = path.join(workDir, "input.pdf");
    fs.copyFileSync(req.file.path, inputPath);
    await convertWithLibreOffice(inputPath, workDir, target.ext, target.infilter);
    const outputPath = path.join(workDir, "input." + target.ext);
    if (!fs.existsSync(outputPath)) throw new Error("Conversion did not produce an output file.");
    res.setHeader("Content-Type", target.mime);
    res.setHeader("Content-Disposition", `attachment; filename="converted.${target.ext}"`);
    fs.createReadStream(outputPath).pipe(res).on("close", () => cleanup(workDir, req.file.path));
  } catch (err) {
    cleanup(workDir, req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ---- Unlock PDF (remove a KNOWN password) ----
app.post("/pdf/unlock", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const password = req.body.password || "";
  const workDir = newWorkDir("unlock");
  const outputPath = path.join(workDir, "unlocked.pdf");
  execFile("qpdf", [`--password=${password}`, "--decrypt", req.file.path, outputPath], { timeout: 20000 }, (err, stdout, stderr) => {
    if (err) {
      cleanup(workDir, req.file.path);
      const msg = /invalid password|failed to open/i.test(stderr || "") ? "Incorrect PDF password." : "Could not unlock this PDF.";
      return res.status(400).json({ error: msg });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="unlocked.pdf"');
    fs.createReadStream(outputPath).pipe(res).on("close", () => cleanup(workDir, req.file.path));
  });
});

// ---- Protect PDF (add a password) ----
app.post("/pdf/protect", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const password = req.body.password;
  if (!password || String(password).length < 1) {
    cleanup(null, req.file.path);
    return res.status(400).json({ error: "A password is required." });
  }
  const workDir = newWorkDir("protect");
  const outputPath = path.join(workDir, "protected.pdf");
  execFile("qpdf", ["--encrypt", password, password, "256", "--", req.file.path, outputPath], { timeout: 20000 }, (err, stdout, stderr) => {
    if (err) {
      cleanup(workDir, req.file.path);
      return res.status(500).json({ error: "Could not protect this PDF: " + (stderr || "").slice(0, 200) });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="protected.pdf"');
    fs.createReadStream(outputPath).pipe(res).on("close", () => cleanup(workDir, req.file.path));
  });
});

// ======================================================================
// Traffic statistics for the admin panel
// ----------------------------------------------------------------------
// The site sends one small beacon per page view (/t) and one per tool
// opened. Here it becomes a row in Supabase (table pb_visits): the page,
// where the visitor came from, device/browser, and the approximate
// country / state / city worked out from the IP address. The IP itself is
// never stored, and nothing is kept on the visitor's device: "visitor" is a
// one-way hash of IP + browser + today's date, so the same person counts
// once a day and cannot be followed from one day to the next.
//
// Everything lives in the Supabase project "PDF Banao" (banaopdf-tech's
// org). The backend talks to it with the project's PUBLISHABLE key, which is
// meant to be public: the tables themselves are closed, and the only way in is
// a handful of database functions (pb_track, pb_admin_login, pb_admin_stats,
// pb_admin_password, pb_admin_logout) that do their own checks.
//
// Admin login: the username and password set in Render -> Environment
// (ADMIN_USER / ADMIN_PASSWORD; a few other common names are accepted too).
// The database keeps a bcrypt hash of the same password and only opens the
// statistics for it. The first login after a new password is set on Render
// links the two once, with the previous password (the setup code the first
// time). Without a password on Render the database password alone is used.
// ======================================================================
const geoCountry = require("geoip-country");  // IPv4 + IPv6, country only, ~13 MB of memory
const geoCity = require("fast-geoip");        // IPv4 state/city, read lazily from disk

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://jbzssifupzyazzddgwjl.supabase.co").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_QPkf2-orVWYG5JML-yHp_w_5rFa6FMi";
const STATS_TZ = "Asia/Kolkata";

/* the login set on Render; the first variable that exists wins */
/* The first listed name that exists wins; failing that, any variable whose
   name matches the pattern, ignoring case (people type "Admin_Password",
   "admin password", "PASSWORD"...). Values are trimmed. */
const envFirst = (names, pattern) => {
  for (const n of names) if (process.env[n] && process.env[n].trim()) return { name: n, value: process.env[n].trim() };
  if (pattern) {
    const hit = Object.keys(process.env).sort().find((n) => pattern.test(n) && process.env[n] && process.env[n].trim());
    if (hit) return { name: hit, value: process.env[hit].trim() };
  }
  return null;
};
const ENV_USER = envFirst(["ADMIN_USER", "ADMIN_USERNAME", "ADMIN_NAME", "ADMIN_ID", "USERNAME"],
  // never bare USER / NAME / ID: a container sets some of those itself
  /^(admin[\s_.-]*(user([\s_.-]*(name|id))?|name|id|login|email)|user[\s_.-]*name|login([\s_.-]*id)?)$/i);
const ENV_PASS = envFirst(["ADMIN_PASSWORD", "ADMIN_PASS", "ADMIN_PWD", "PASSWORD"],
  // never bare PWD: that is the shell's working directory, not a password
  /^(admin[\s_.-]*(pass(word)?|pwd|passcode)|pass(word)?|passcode)$/i);
/* names (never values) of variables that look like they were meant for this,
   so the admin panel can say what Render is actually handing over */
const envLookalikes = () => Object.keys(process.env).filter((n) => /user|pass|pwd|admin|login|razor|rzp/i.test(n)).sort();

/* call one of the database functions; resolves to { ok, status, data } */
async function rpc(name, args) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  // legacy keys are JWTs and go in Authorization too; sb_publishable_ keys only as apikey
  if (/^eyJ/.test(SUPABASE_KEY)) headers.Authorization = "Bearer " + SUPABASE_KEY;
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: r.ok, status: r.status, data };
}

const IN_STATES = {
  AN: "Andaman & Nicobar", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar",
  CH: "Chandigarh", CT: "Chhattisgarh", CG: "Chhattisgarh", DN: "Dadra & Nagar Haveli", DD: "Daman & Diu",
  DH: "Dadra & Nagar Haveli and Daman & Diu", DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana",
  HP: "Himachal Pradesh", JK: "Jammu & Kashmir", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala",
  LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya",
  MZ: "Mizoram", NL: "Nagaland", OR: "Odisha", OD: "Odisha", PY: "Puducherry", PB: "Punjab", RJ: "Rajasthan",
  SK: "Sikkim", TN: "Tamil Nadu", TG: "Telangana", TS: "Telangana", TR: "Tripura", UP: "Uttar Pradesh",
  UT: "Uttarakhand", UK: "Uttarakhand", WB: "West Bengal",
};

function clientIp(req) {
  const h = req.headers;
  const ip = (h["cf-connecting-ip"] || h["true-client-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] ||
    req.socket.remoteAddress || "").trim();
  return ip.replace(/^::ffff:/, "");
}

async function locate(req, ip) {
  let country = null, region = null, city = null;
  const cf = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(cf) && cf !== "XX" && cf !== "T1") country = cf;
  try { if (!country) { const c = geoCountry.lookup(ip); if (c && c.country) country = c.country; } } catch (e) {}
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    try {
      const g = await geoCity.lookup(ip);
      if (g && (!country || g.country === country)) {
        country = country || g.country || null;
        if (g.region) region = country === "IN" ? (IN_STATES[g.region] || g.region) : g.region;
        if (g.city) city = g.city;
      }
    } catch (e) {}
  }
  return { country, region, city };
}

function readAgent(ua) {
  const s = String(ua || "");
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s) ? "tablet"
    : /Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(s) ? "mobile" : "desktop";
  const browser = /SamsungBrowser/i.test(s) ? "Samsung Internet" : /OPR\/|Opera/i.test(s) ? "Opera"
    : /Edg\//i.test(s) ? "Edge" : /UCBrowser/i.test(s) ? "UC Browser" : /FBAN|FBAV|Instagram/i.test(s) ? "Facebook/Instagram app"
    : /; wv\)/i.test(s) ? "Android app (webview)" : /Firefox|FxiOS/i.test(s) ? "Firefox" : /CriOS|Chrome/i.test(s) ? "Chrome"
    : /Safari/i.test(s) ? "Safari" : "Other";
  const os = /Windows/i.test(s) ? "Windows" : /Android/i.test(s) ? "Android" : /iPhone|iPad|iPod/i.test(s) ? "iOS"
    : /Mac OS X|Macintosh/i.test(s) ? "macOS" : /CrOS/i.test(s) ? "ChromeOS" : /Linux/i.test(s) ? "Linux" : "Other";
  return { device, browser, os };
}
const isBot = (ua) => !ua || /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|go-http/i.test(ua);

/* where a visit came from, in words */
function sourceOf(refHost, utmSource, ownHost) {
  const u = String(utmSource || "").toLowerCase();
  const h = String(refHost || "").toLowerCase();
  const rules = [
    [/mail\.google|android\.gm$/, "Gmail"], [/google/, "Google"], [/bing/, "Bing"], [/yahoo/, "Yahoo"], [/duckduckgo/, "DuckDuckGo"], [/yandex/, "Yandex"],
    [/whatsapp|wa\.me/, "WhatsApp"], [/facebook|fb\.com|fb\.me|^m\.facebook/, "Facebook"], [/instagram/, "Instagram"],
    [/youtube|youtu\.be/, "YouTube"], [/t\.co$|twitter|^x\.com/, "X (Twitter)"], [/linkedin|lnkd\.in/, "LinkedIn"],
    [/telegram|t\.me/, "Telegram"], [/reddit/, "Reddit"], [/quora/, "Quora"], [/pinterest/, "Pinterest"],
    [/chatgpt|openai/, "ChatGPT"], [/perplexity/, "Perplexity"], [/gemini\.google|bard\.google/, "Gemini"],
    [/claude\.ai/, "Claude"], [/copilot|bing\.com\/chat/, "Copilot"],
  ];
  if (u) { for (const [re, name] of rules) if (re.test(u)) return name; return u.slice(0, 60); }
  if (!h || h === ownHost) return "Direct";
  // AI assistants first: gemini.google.com must not read as Google search
  for (const [re, name] of rules.slice(-5)) if (re.test(h)) return name;
  for (const [re, name] of rules) if (re.test(h)) return name;
  return h.replace(/^www\./, "").slice(0, 60);
}

/* per-IP limits, in memory: enough to stop a loop or a password guesser */
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  let e = hits.get(key);
  if (!e || now - e.start > windowMs) { e = { start: now, n: 0 }; hits.set(key, e); }
  e.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > 3600e3) hits.delete(k);
  return e.n > max;
}

const cut = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

app.post("/t", express.text({ type: "*/*", limit: "4kb" }), async (req, res) => {
  res.status(204).end();                      // the visitor never waits for any of this
  try {
    const ua = String(req.headers["user-agent"] || "");
    if (isBot(ua)) return;
    const ip = clientIp(req);
    if (tooMany("t|" + ip, 120, 60e3)) return;
    let d;
    try { d = JSON.parse(req.body || "{}"); } catch (e) { return; }
    if (!d || (d.k !== "page" && d.k !== "tool" && d.k !== "paywall")) return;

    let ownHost = null;
    try { ownHost = new URL(String(d.u || "")).host.toLowerCase(); } catch (e) {}
    let refHost = null;
    const ref = String(d.r || "");
    const viaApp = /^android-app:\/\/([\w.]+)/.exec(ref);      // an Android app that opened the link
    if (viaApp) refHost = viaApp[1].toLowerCase();
    else if (ref) { try { refHost = new URL(ref).host.toLowerCase(); } catch (e) {} }
    if (refHost === "com.whatsapp" || refHost === "com.whatsapp.w4b") refHost = "whatsapp.com";
    if (refHost && refHost === ownHost) refHost = null;
    const entry = d.k === "page" && !!d.e;
    const place = await locate(req, ip);
    const agent = readAgent(ua);
    const row = {
      kind: d.k,
      path: cut(String(d.p || "/").split("?")[0], 200),
      tool: cut(d.tool && /^[\w-]+$/.test(String(d.tool)) ? d.tool : null, 60),
      entry,
      src: entry ? sourceOf(refHost, d.us, ownHost) : null,
      ref_host: entry ? cut(refHost, 120) : null,
      utm_source: cut(d.us, 80), utm_medium: cut(d.um, 80), utm_campaign: cut(d.uc, 80),
      country: place.country, region: cut(place.region, 80), city: cut(place.city, 80),
      device: agent.device, browser: agent.browser, os: agent.os,
      lang: cut(d.l, 20), screen: cut(d.s && /^\d{2,5}x\d{2,5}$/.test(String(d.s)) ? d.s : null, 20),
    };
    // the IP and browser go along only to make the daily visitor code in the
    // database (with a salt that never leaves it); neither is stored
    const r = await rpc("pb_track", { p: row, p_ip: ip, p_ua: ua });
    if (!r.ok) console.error("stats insert failed", r.status, JSON.stringify(r.data).slice(0, 200));
  } catch (err) {
    console.error("stats error", err && err.message);
  }
});

/* ---- admin panel ---- */
const bearer = (req) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").slice(0, 200);

const sameSecret = (x, y) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(String(x)).digest(), crypto.createHash("sha256").update(String(y)).digest());

/* names only, never values: lets the panel say what Render is providing */
app.get("/admin/status", (req, res) => res.json({
  mode: ENV_PASS ? "env" : "db", userVar: ENV_USER ? ENV_USER.name : null, passVar: ENV_PASS ? ENV_PASS.name : null,
  seen: envLookalikes(),
  password: true, database: !!SUPABASE_KEY,
}));

app.post("/admin/login", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("login|" + ip, 8, 15 * 60e3)) return res.status(429).json({ error: "Bahut baar galat try hua. 15 minute baad dobara karo." });
  const user = String((req.body || {}).user || "").trim().slice(0, 60);
  const password = String((req.body || {}).password || "").slice(0, 100);
  const setup = String((req.body || {}).setup || "").slice(0, 100);
  const fail = (code, error, extra) => res.status(code).json(Object.assign({ error }, extra || {}));
  try {
    if (!ENV_PASS) {
      // no login on Render: the database password is the login
      const r = await rpc("pb_admin_login", { p_user: user, p_pass: password });
      const d = r.data || {};
      if (!r.ok) return fail(502, "Database se jawab nahi aaya (" + r.status + ").");
      if (d.error === "locked") return fail(429, "Bahut baar galat password dala gaya. 15 minute baad try karo.");
      if (d.error || !d.token) return fail(401, "Username ya password galat hai.");
      hits.delete("login|" + ip);
      return res.json({ token: d.token, user: d.user, mustChange: !!d.must_change, mode: "db" });
    }

    // the login on Render decides who gets in
    const wantUser = ENV_USER ? ENV_USER.value : "admin";
    if (!sameSecret(user.toLowerCase(), wantUser.trim().toLowerCase()) || !sameSecret(password, ENV_PASS.value)) {
      return fail(401, "Username ya password galat hai.");
    }
    hits.delete("login|" + ip);
    let r = await rpc("pb_admin_login", { p_user: "admin", p_pass: ENV_PASS.value });
    if (!r.ok) return fail(502, "Database se jawab nahi aaya (" + r.status + ").");
    if (r.data && r.data.error === "locked") return fail(429, "Bahut baar galat password dala gaya. 15 minute baad try karo.");
    if (r.data && r.data.token) return res.json({ token: r.data.token, user: wantUser, mustChange: false, mode: "env" });

    // Render has a password the database does not know yet: link them once,
    // with the password the database had before (the setup code, first time)
    if (!setup) return fail(409, "Ek baar pichhla admin password chahiye.", { needSetup: true });
    const old = await rpc("pb_admin_login", { p_user: "admin", p_pass: setup });
    if (!old.ok || !old.data || !old.data.token) return fail(401, "Pichhla password galat hai.", { needSetup: true });
    const ch = await rpc("pb_admin_password", { p_token: old.data.token, p_old: setup, p_new: ENV_PASS.value });
    const e = ch.data && ch.data.error;
    if (e === "length") return fail(400, "Render wala password 8 se 72 akshar ka hona chahiye. Render par badal ke dobara try karo.");
    if (!ch.ok || (e && e !== "same")) return fail(400, "Jod nahi paye. Dobara try karo.", { needSetup: true });
    r = await rpc("pb_admin_login", { p_user: "admin", p_pass: ENV_PASS.value });
    if (!r.data || !r.data.token) return fail(502, "Jod diya, par login nahi hua. Dobara try karo.");
    res.json({ token: r.data.token, user: wantUser, mustChange: false, mode: "env", linked: true });
  } catch (err) {
    fail(502, "Database tak nahi pahunch paye.");
  }
});

app.post("/admin/password", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("pw|" + ip, 10, 15 * 60e3)) return res.status(429).json({ error: "Bahut baar try hua. 15 minute baad dobara karo." });
  const { oldPassword, newPassword } = req.body || {};
  if (ENV_PASS) return res.status(400).json({ error: "Password Render par set hai — wahin Environment me badlo." });
  try {
    const r = await rpc("pb_admin_password", { p_token: bearer(req), p_old: String(oldPassword || ""), p_new: String(newPassword || "") });
    const d = r.data || {};
    if (!r.ok) return res.status(502).json({ error: "Database se jawab nahi aaya (" + r.status + ")." });
    const why = { auth: [401, "Login dobara karo."], old: [400, "Purana password galat hai."],
      length: [400, "Naya password 8 se 72 akshar ka hona chahiye."], same: [400, "Naya password purane se alag hona chahiye."] };
    if (d.error) { const [code, msg] = why[d.error] || [400, "Password nahi badla."]; return res.status(code).json({ error: msg }); }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: "Database tak nahi pahunch paye." });
  }
});

app.post("/admin/logout", async (req, res) => {
  try { await rpc("pb_admin_logout", { p_token: bearer(req) }); } catch (e) {}
  res.json({ ok: true });
});

/* the time range, in Indian time: today, yesterday, or the last N days */
function rangeOf(q) {
  const IST = 5.5 * 3600e3;
  const now = Date.now();
  const midnight = Math.floor((now + IST) / 86400e3) * 86400e3 - IST;   // today 00:00 IST, as UTC ms
  // "up to now" ends a few minutes ahead, so a server clock running slightly
  // behind the database's never hides the visits that just came in
  const soon = now + 5 * 60e3;
  const r = String(q.range || "7d");
  if (r === "today") return [midnight, soon];
  if (r === "yesterday") return [midnight - 86400e3, midnight];
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ""))) {
    const f = Date.parse(q.from + "T00:00:00+05:30"), t = Date.parse(q.to + "T00:00:00+05:30") + 86400e3;
    if (t > f && t - f <= 400 * 86400e3) return [f, Math.min(t, soon)];
  }
  const days = Math.min(365, Math.max(1, parseInt(r, 10) || 7));
  return [midnight - (days - 1) * 86400e3, soon];
}

app.get("/admin/stats", async (req, res) => {
  const [from, to] = rangeOf(req.query);
  try {
    const r = await rpc("pb_admin_stats", {
      p_token: bearer(req), p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_tz: STATS_TZ,
    });
    if (!r.ok) return res.status(502).json({ error: "Database se data nahi aaya (" + r.status + ")." });
    if (r.data && r.data.error === "auth") return res.status(401).json({ error: "Login dobara karo." });
    if (!r.data || r.data.error) return res.status(400).json({ error: "Ye samay-seema nahi chal sakti." });
    res.setHeader("Cache-Control", "no-store");
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: "Database tak nahi pahunch paye." });
  }
});

/* ---- admin reports: same checks and messages as /admin/stats ---- */
async function adminReport(res, name, args) {
  try {
    const r = await rpc(name, args);
    if (!r.ok) return res.status(502).json({ error: "Database se data nahi aaya (" + r.status + ")." });
    if (r.data && r.data.error === "auth") return res.status(401).json({ error: "Login dobara karo." });
    if (!r.data || r.data.error) return res.status(400).json({ error: "Ye samay-seema nahi chal sakti." });
    res.setHeader("Cache-Control", "no-store");
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: "Database tak nahi pahunch paye." });
  }
}
/* search text and paging for the order / user lists */
function pageOf(q) {
  const limit = parseInt(q.limit, 10), offset = parseInt(q.offset, 10);
  return {
    p_q: String(q.q || "").slice(0, 100),
    p_limit: Number.isFinite(limit) ? Math.min(200, Math.max(1, limit)) : 50,
    p_offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
  };
}
const isoRange = (q) => { const [from, to] = rangeOf(q); return { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() }; };

app.get("/admin/revenue", (req, res) =>
  adminReport(res, "pb_admin_revenue", Object.assign({ p_token: bearer(req) }, isoRange(req.query), { p_tz: STATS_TZ })));
app.get("/admin/orders", (req, res) => {
  const status = ["all", "paid", "pending"].includes(req.query.status) ? req.query.status : "all";
  const pg = pageOf(req.query);
  adminReport(res, "pb_admin_orders", Object.assign({ p_token: bearer(req) }, isoRange(req.query),
    { p_status: status, p_q: pg.p_q, p_limit: pg.p_limit, p_offset: pg.p_offset }));
});
app.get("/admin/recover", (req, res) =>
  adminReport(res, "pb_admin_recover", Object.assign({ p_token: bearer(req) }, isoRange(req.query))));
app.get("/admin/users", (req, res) =>
  adminReport(res, "pb_admin_users", Object.assign({ p_token: bearer(req) }, pageOf(req.query))));
app.get("/admin/funnel", (req, res) =>
  adminReport(res, "pb_admin_funnel", Object.assign({ p_token: bearer(req) }, isoRange(req.query), { p_tz: STATS_TZ })));
app.get("/admin/utm", (req, res) =>
  adminReport(res, "pb_admin_utm", Object.assign({ p_token: bearer(req) }, isoRange(req.query))));
app.get("/admin/growth", (req, res) =>
  adminReport(res, "pb_admin_growth", Object.assign({ p_token: bearer(req) }, isoRange(req.query), { p_tz: STATS_TZ })));

/* server health: the in-memory counters above, for a logged-in admin */
app.get("/admin/health", async (req, res) => {
  try {
    const r = await rpc("pb_admin_ok", { p_token: bearer(req) });
    if (!r.ok || r.data !== true) return res.status(401).json({ error: "Login dobara karo." });
    res.setHeader("Cache-Control", "no-store");
    const mem = process.memoryUsage();
    const routes = Object.keys(health.routes).map((route) => {
      const s = health.routes[route] || {};
      return { route, hits: s.count || 0, errors: s.errors || 0, slow: s.slow || 0 };
    }).sort((a, b) => b.hits - a.hits);
    res.json({
      uptime_sec: Math.round((Date.now() - health.startTime) / 1000),
      memory: { rss_mb: mem.rss / 1048576, heap_mb: mem.heapUsed / 1048576 },
      requests_total: health.requestsTotal, routes,
      errors_recent: health.errorsRecent.map((e) => ({ ts: e.ts, route: e.route, msg: e.message })),
      payments: health.payments,
    });
  } catch (err) {
    res.status(502).json({ error: "Database tak nahi pahunch paye." });
  }
});

// ======================================================================
// Paid tools, user accounts and Razorpay
// ----------------------------------------------------------------------
// Prices and free limits are set in the admin panel (table pb_tool_price).
// A paid tool can be used freely; its download asks /paid/use, which allows
// it with an active pass, a bought single download, or while the free uses
// of the window last. After that the site asks the visitor to register /
// log in and pay: a pass (30 days / 365 days / life) or one download.
//
// Every payment is a one-time Razorpay order. The amount always comes from
// the database, never from the browser, and access is granted only after
// Razorpay's signature checks out with the secret key. Render -> Environment:
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   (RAZORPAY_WEBHOOK_SECRET optional)
// Granting access also needs the backend's database key, which is the admin
// password on Render (the first admin login links it to the database).
// ======================================================================
const RZP_ID = envFirst(["RAZORPAY_KEY_ID", "RAZORPAY_KEY", "RAZORPAY_API_KEY", "RAZORPAY_ID", "RAZORPAY_KEYID"],
  /^(razorpay|rzp)[\s_.-]*(api[\s_.-]*)?(key[\s_.-]*)?id$|^(razorpay|rzp)[\s_.-]*(api[\s_.-]*)?key$/i);
const RZP_SECRET = envFirst(["RAZORPAY_KEY_SECRET", "RAZORPAY_SECRET", "RAZORPAY_SECRET_KEY", "RAZORPAY_API_SECRET", "RAZORPAY_KEYSECRET"],
  /^(razorpay|rzp)[\s_.-]*(api[\s_.-]*)?(key[\s_.-]*)?secret([\s_.-]*key)?$/i);
const RZP_WEBHOOK = envFirst(["RAZORPAY_WEBHOOK_SECRET"]);
const payReady = () => !!(RZP_ID && RZP_SECRET);
const dbKey = () => (ENV_PASS ? ENV_PASS.value : "");

let paidCache = { at: 0, data: null };
async function paidConfig() {
  if (paidCache.data && Date.now() - paidCache.at < 60e3) return paidCache.data;
  const r = await rpc("pb_paid_config", {});
  if (!r.ok || !Array.isArray(r.data)) throw new Error("config " + r.status);
  paidCache = { at: Date.now(), data: r.data };
  return r.data;
}

app.get("/paid/config", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json({ tools: await paidConfig(), payments: payReady() }); }
  catch (err) { res.status(502).json({ error: "config", tools: [] }); }
});

/* may this download go ahead? */
app.post("/paid/use", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("use|" + ip, 60, 60e3)) return res.status(429).json({ allowed: false, error: "Thodi der baad try karo." });
  const tool = String((req.body || {}).tool || "").slice(0, 60);
  const device = String((req.body || {}).device || "").slice(0, 80);
  if (!/^[a-z0-9-]{2,60}$/.test(tool)) return res.json({ allowed: true, reason: "unknown-tool" });
  try {
    const r = await rpc("pb_use", { p_tool: tool, p_device: device || ip, p_ip: ip, p_user_token: bearer(req) });
    if (!r.ok || !r.data) return res.status(502).json({ allowed: true, reason: "db-down" });   // never block on our own outage
    res.json(Object.assign({ payments: payReady() }, r.data));
  } catch (err) {
    res.status(502).json({ allowed: true, reason: "db-down" });
  }
});

/* ---- visitor accounts ---- */
const USER_ERRORS = {
  name: "Apna naam likho.", mobile: "10 ank ka sahi mobile number daalo.", email: "Sahi email id daalo.",
  password: "Password 8 se 72 akshar ka rakho.", exists: "Is email se account pehle se hai — Login karo.",
  bad: "Email ya password galat hai.", locked: "Bahut baar galat password. 15 minute baad try karo.", auth: "Dobara login karo.",
};
app.post("/user/register", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("reg|" + ip, 10, 60 * 60e3)) return res.status(429).json({ error: "Bahut saare account ban gaye. Thodi der baad try karo." });
  const b = req.body || {};
  try {
    const r = await rpc("pb_user_register", { p_name: String(b.name || "").slice(0, 80), p_mobile: String(b.mobile || "").slice(0, 20),
      p_email: String(b.email || "").slice(0, 120), p_pass: String(b.password || "").slice(0, 100) });
    const d = r.data || {};
    if (!r.ok) return res.status(502).json({ error: "Server se jawab nahi aaya. Dobara try karo." });
    if (d.error) return res.status(400).json({ error: USER_ERRORS[d.error] || "Account nahi bana.", field: d.error });
    res.json(d);
  } catch (err) { res.status(502).json({ error: "Server tak nahi pahunch paye." }); }
});
app.post("/user/login", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("ulogin|" + ip, 20, 15 * 60e3)) return res.status(429).json({ error: USER_ERRORS.locked });
  const b = req.body || {};
  try {
    const r = await rpc("pb_user_login", { p_email: String(b.email || "").slice(0, 120), p_pass: String(b.password || "").slice(0, 100) });
    const d = r.data || {};
    if (!r.ok) return res.status(502).json({ error: "Server se jawab nahi aaya. Dobara try karo." });
    if (d.error) return res.status(d.error === "locked" ? 429 : 401).json({ error: USER_ERRORS[d.error] || "Login nahi hua." });
    res.json(d);
  } catch (err) { res.status(502).json({ error: "Server tak nahi pahunch paye." }); }
});
app.get("/user/me", async (req, res) => {
  try {
    const r = await rpc("pb_user_me", { p_token: bearer(req) });
    if (!r.ok) return res.status(502).json({ error: "Server se jawab nahi aaya." });
    if (r.data && r.data.error) return res.status(401).json({ error: USER_ERRORS.auth });
    res.json(r.data);
  } catch (err) { res.status(502).json({ error: "Server tak nahi pahunch paye." }); }
});
app.post("/user/logout", async (req, res) => {
  try { await rpc("pb_user_logout", { p_token: bearer(req) }); } catch (e) {}
  res.json({ ok: true });
});

/* ---- Razorpay ---- */
function razorpay(pathname, body) {
  const auth = Buffer.from(RZP_ID.value + ":" + RZP_SECRET.value).toString("base64");
  return fetch((process.env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1") + pathname, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + auth }, body: JSON.stringify(body),
  });
}

app.post("/pay/order", express.json({ limit: "2kb" }), async (req, res) => {
  const ip = clientIp(req);
  if (tooMany("order|" + ip, 20, 15 * 60e3)) { payFail("order", "rate_limit"); return res.status(429).json({ error: "Thodi der baad try karo." }); }
  if (!payReady()) { payFail("order", "not_ready"); return res.status(503).json({ error: "Payment abhi band hai — admin ko Render par Razorpay keys daalni hain." }); }
  if (!ENV_PASS) { payFail("order", "no_admin_pass"); return res.status(503).json({ error: "Payment abhi band hai — Render par ADMIN_PASSWORD chahiye." }); }
  const tool = String((req.body || {}).tool || "").slice(0, 60);
  const kind = (req.body || {}).kind === "once" ? "once" : "pass";
  const receipt = "pb_" + Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
  try {
    const st = await rpc("pb_order_start", { p_key: dbKey(), p_user_token: bearer(req), p_tool: tool, p_receipt: receipt, p_kind: kind });
    const d = st.data || {};
    if (!st.ok) { payFail("order", "db:down"); return res.status(502).json({ error: "Server se jawab nahi aaya." }); }
    if (d.error === "auth") { payFail("order", "db:auth"); return res.status(401).json({ error: USER_ERRORS.auth }); }
    if (d.error === "key") { payFail("order", "db:key"); return res.status(503).json({ error: "Payment abhi setup ho raha hai — admin ko ek baar admin panel me login karna hai." }); }
    if (d.error === "kind") { payFail("order", "db:kind"); return res.status(400).json({ error: "Is tool ke liye ye option abhi nahi hai." }); }
    if (d.error) { payFail("order", "db:tool"); return res.status(400).json({ error: "Ye tool abhi paid nahi hai." }); }
    const rz = await razorpay("/orders", { amount: d.amount, currency: "INR", receipt, notes: { tool, kind, email: d.user.email } });
    const order = await rz.json().catch(() => ({}));
    if (!rz.ok || !order.id) {
      console.error("razorpay order failed", rz.status, JSON.stringify(order).slice(0, 300));
      payFail("order", "razorpay_order");
      return res.status(502).json({ error: rz.status === 401 ? "Razorpay keys galat hain (admin check kare)." : "Razorpay se order nahi bana. Dobara try karo." });
    }
    await rpc("pb_order_attach", { p_key: dbKey(), p_receipt: receipt, p_order_id: order.id });
    payOk("order");
    res.json({ orderId: order.id, amount: d.amount, currency: "INR", keyId: RZP_ID.value, toolName: d.toolName,
      kind, period: d.period, user: d.user });
  } catch (err) {
    console.error("order error", err && err.message);
    payFail("order", "exception");
    res.status(502).json({ error: "Payment shuru nahi ho paya. Dobara try karo." });
  }
});

/* Razorpay's own proof that this payment is for this order */
function signatureOk(orderId, paymentId, signature) {
  if (!RZP_SECRET || !orderId || !paymentId || !signature) return false;
  const want = crypto.createHmac("sha256", RZP_SECRET.value).update(orderId + "|" + paymentId).digest("hex");
  return want.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(signature)));
}

app.post("/pay/verify", express.json({ limit: "2kb" }), async (req, res) => {
  const b = req.body || {};
  const orderId = String(b.orderId || "").slice(0, 60), paymentId = String(b.paymentId || "").slice(0, 60);
  if (!signatureOk(orderId, paymentId, String(b.signature || "").slice(0, 200))) {
    payFail("verify", "bad_signature");
    return res.status(400).json({ error: "Payment ki pushti nahi hui. Paise kate hon to humein email karo — hum jod denge." });
  }
  try {
    const r = await rpc("pb_order_paid", { p_key: dbKey(), p_order_id: orderId, p_payment_id: paymentId });
    const d = r.data || {};
    if (!r.ok || d.error) {
      console.error("order paid failed", r.status, JSON.stringify(d).slice(0, 200));
      payFail("verify", "grant_failed");
      return res.status(502).json({ error: "Payment mil gaya, par account me judne me dikkat hui. Humein email karo — hum jod denge." });
    }
    const me = await rpc("pb_user_me", { p_token: bearer(req) });
    payOk("verify");
    res.json({ ok: true, tool: d.tool, kind: d.kind, subs: (me.data && me.data.subs) || d.subs || [] });
  } catch (err) {
    payFail("verify", "exception");
    res.status(502).json({ error: "Payment mil gaya, par account me judne me dikkat hui. Thodi der me dobara try karo." });
  }
});

/* optional: Razorpay tells us directly, in case the visitor closed the page */
app.post("/pay/webhook", express.raw({ type: "*/*", limit: "100kb" }), async (req, res) => {
  if (!RZP_WEBHOOK) return res.status(404).end();
  const sig = String(req.headers["x-razorpay-signature"] || "");
  const want = crypto.createHmac("sha256", RZP_WEBHOOK.value).update(req.body || "").digest("hex");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return res.status(400).end();
  res.status(200).json({ ok: true });
  try {
    const ev = JSON.parse(req.body.toString("utf8"));
    const pay = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if (pay && pay.order_id && (ev.event === "payment.captured" || ev.event === "order.paid")) {
      await rpc("pb_order_paid", { p_key: dbKey(), p_order_id: pay.order_id, p_payment_id: pay.id });
    }
  } catch (err) { console.error("webhook error", err && err.message); }
});

/* ---- admin: paid tools ---- */
app.get("/admin/tools", async (req, res) => {
  try {
    const r = await rpc("pb_admin_tools_get", { p_token: bearer(req) });
    if (!r.ok) return res.status(502).json({ error: "Database se jawab nahi aaya." });
    if (r.data && r.data.error === "auth") return res.status(401).json({ error: "Login dobara karo." });
    res.setHeader("Cache-Control", "no-store");
    res.json(Object.assign({ payments: { keyVar: RZP_ID ? RZP_ID.name : null, secretVar: RZP_SECRET ? RZP_SECRET.name : null,
      webhook: !!RZP_WEBHOOK, test: !!(RZP_ID && /^rzp_test_/.test(RZP_ID.value)), adminPass: !!ENV_PASS } }, r.data));
  } catch (err) { res.status(502).json({ error: "Database tak nahi pahunch paye." }); }
});
app.post("/admin/tools", express.json({ limit: "64kb" }), async (req, res) => {
  const rows = Array.isArray((req.body || {}).tools) ? req.body.tools : null;
  if (!rows) return res.status(400).json({ error: "Kuch save karne ko nahi mila." });
  try {
    const r = await rpc("pb_admin_tools_save", { p_token: bearer(req), p_rows: rows });
    const d = r.data || {};
    if (!r.ok) return res.status(502).json({ error: "Database se jawab nahi aaya." });
    if (d.error === "auth") return res.status(401).json({ error: "Login dobara karo." });
    if (d.error === "price") return res.status(400).json({ error: "Paid tool ka offer price kam se kam ₹1 hona chahiye (" + d.tool + ")." });
    if (d.error) return res.status(400).json({ error: "Save nahi hua." });
    paidCache = { at: 0, data: null };
    res.json(d);
  } catch (err) { res.status(502).json({ error: "Database tak nahi pahunch paye." }); }
});

// multer / generic error handler (keeps failures as clean JSON, never a raw crash page)
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB.` });
  }
  res.status(500).json({ error: (err && err.message) || "Server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PDF Banao backend listening on port " + PORT));
