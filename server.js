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
const envFirst = (names) => { for (const n of names) if (process.env[n]) return { name: n, value: String(process.env[n]) }; return null; };
const ENV_USER = envFirst(["ADMIN_USER", "ADMIN_USERNAME", "ADMIN_NAME", "ADMIN_ID", "USERNAME"]);
const ENV_PASS = envFirst(["ADMIN_PASSWORD", "ADMIN_PASS", "ADMIN_PWD", "PASSWORD"]);

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
    if (!d || (d.k !== "page" && d.k !== "tool")) return;

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
