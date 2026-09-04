// PDF Banao — backend conversion service
// Handles the tools that genuinely need server-side software:
//   Office (Word/PowerPoint/Excel) <-> PDF   — via LibreOffice headless
//   Unlock PDF / Protect PDF                  — via qpdf
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

// multer / generic error handler (keeps failures as clean JSON, never a raw crash page)
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB.` });
  }
  res.status(500).json({ error: (err && err.message) || "Server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PDF Banao backend listening on port " + PORT));
