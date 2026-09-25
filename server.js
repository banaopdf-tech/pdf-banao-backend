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
// Needs two environment variables on Render (never in this file — the repo
// is public):
//   SUPABASE_SERVICE_KEY  the project's service_role / secret key
//   ADMIN_PASSWORD        the admin panel password   (ADMIN_USER, default "admin")
// Without them tracking is skipped and the admin panel says what is missing.
// ======================================================================
const geoCountry = require("geoip-country");  // IPv4 + IPv6, country only, ~13 MB of memory
const geoCity = require("fast-geoip");        // IPv4 state/city, read lazily from disk

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://csrzyikbmtmhkmjbbpio.supabase.co").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const STATS_TZ = "Asia/Kolkata";

function supabase(pathname, body, prefer) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  if (prefer) headers.Prefer = prefer;
  // legacy service_role keys are JWTs and go in Authorization too; the newer
  // sb_secret_ keys must only be sent as apikey
  if (/^eyJ/.test(SUPABASE_KEY)) headers.Authorization = "Bearer " + SUPABASE_KEY;
  return fetch(SUPABASE_URL + pathname, { method: "POST", headers, body: JSON.stringify(body) });
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

/* a visitor code that is the same all day and useless tomorrow */
function visitorOf(ip, ua) {
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST date
  const salt = crypto.createHmac("sha256", "pb-visitor|" + SUPABASE_KEY).update(day).digest();
  return crypto.createHmac("sha256", salt).update(ip + "|" + ua).digest("hex").slice(0, 20);
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
    if (!SUPABASE_KEY) return;
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
      visitor: visitorOf(ip, ua),
    };
    const r = await supabase("/rest/v1/pb_visits", row, "return=minimal");
    if (!r.ok) console.error("stats insert failed", r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error("stats error", err && err.message);
  }
});

/* ---- admin: login gives a signed token that lasts 12 hours ---- */
const tokenKey = () => crypto.createHash("sha256").update("pb-admin|" + ADMIN_PASSWORD + "|" + SUPABASE_KEY).digest();
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function makeToken() {
  const payload = b64u(JSON.stringify({ u: ADMIN_USER, exp: Date.now() + 12 * 3600e3 }));
  return payload + "." + b64u(crypto.createHmac("sha256", tokenKey()).update(payload).digest());
}
function tokenOk(tok) {
  if (!ADMIN_PASSWORD || !tok) return false;
  const [payload, sig] = String(tok).split(".");
  if (!payload || !sig) return false;
  const want = b64u(crypto.createHmac("sha256", tokenKey()).update(payload).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64").toString()).exp > Date.now(); } catch (e) { return false; }
}
const sameSecret = (a, b) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());

app.get("/admin/status", (req, res) => res.json({ password: !!ADMIN_PASSWORD, database: !!SUPABASE_KEY }));

app.post("/admin/login", express.json({ limit: "2kb" }), (req, res) => {
  const ip = clientIp(req);
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "ADMIN_PASSWORD Render par set nahi hai." });
  if (tooMany("login|" + ip, 8, 15 * 60e3)) return res.status(429).json({ error: "Bahut baar galat try hua. 15 minute baad dobara karo." });
  const { user, password } = req.body || {};
  if (!sameSecret(user || "", ADMIN_USER) || !sameSecret(password || "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Username ya password galat hai." });
  }
  hits.delete("login|" + ip);
  res.json({ token: makeToken(), user: ADMIN_USER });
});

/* the time range, in Indian time: today, yesterday, or the last N days */
function rangeOf(q) {
  const IST = 5.5 * 3600e3;
  const now = Date.now();
  const midnight = Math.floor((now + IST) / 86400e3) * 86400e3 - IST;   // today 00:00 IST, as UTC ms
  const r = String(q.range || "7d");
  if (r === "today") return [midnight, now];
  if (r === "yesterday") return [midnight - 86400e3, midnight];
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || "")) && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ""))) {
    const f = Date.parse(q.from + "T00:00:00+05:30"), t = Date.parse(q.to + "T00:00:00+05:30") + 86400e3;
    if (t > f && t - f <= 400 * 86400e3) return [f, Math.min(t, now)];
  }
  const days = Math.min(365, Math.max(1, parseInt(r, 10) || 7));
  return [midnight - (days - 1) * 86400e3, now];
}

app.get("/admin/stats", async (req, res) => {
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tokenOk(tok)) return res.status(401).json({ error: "Login dobara karo." });
  if (!SUPABASE_KEY) return res.status(503).json({ error: "SUPABASE_SERVICE_KEY Render par set nahi hai." });
  const [from, to] = rangeOf(req.query);
  try {
    const r = await supabase("/rest/v1/rpc/pb_stats", {
      p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_tz: STATS_TZ,
    });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: "Database se data nahi aaya (" + r.status + ")." });
    res.setHeader("Cache-Control", "no-store");
    res.type("application/json").send(text);
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
