"use strict";

// Files uploaded by the people who USE a generated app: a CV attached to a job
// application, a photo on a listing, a PDF on a claim form.
//
// Two decisions shape everything here.
//
// Files are stored in Supabase Storage but served back through our own API
// rather than from a storage URL. Published apps run under a strict
// Content-Security-Policy where images may come from 'self' and nowhere else,
// so a storage-hosted URL would simply not render. Proxying keeps the policy
// tight instead of widening it for every app in order to serve a few files.
//
// And the type of a file is decided by looking at its bytes, not by trusting
// what the uploader claimed. A stranger picked this file; the Content-Type
// header is theirs to lie about.

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_FILES_PER_APP = 200;
const MAX_BYTES_PER_APP = 50 * 1024 * 1024; // 50MB
const BUCKET = "app-files";

// Every type here is one a browser renders or downloads inertly. Notably
// absent: SVG (can carry script), HTML (obviously), and anything executable.
// A generated app can still accept "any document" - it just cannot accept one
// that runs.
const ALLOWED = [
  { mime: "image/png", ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { mime: "image/jpeg", ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  { mime: "image/gif", ext: "gif", magic: [[0x47, 0x49, 0x46, 0x38]] },
  { mime: "image/webp", ext: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF....WEBP
  { mime: "application/pdf", ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46]] },
];

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

// Returns the entry whose signature the bytes actually match, or null. WebP
// needs its second check: RIFF alone is also AVI and WAV.
function sniff(buf) {
  if (!buf || !buf.length) return null;
  for (const entry of ALLOWED) {
    for (const sig of entry.magic) {
      if (!startsWith(buf, sig)) continue;
      if (entry.mime === "image/webp") {
        const tag = buf.slice(8, 12).toString("ascii");
        if (tag !== "WEBP") continue;
      }
      return entry;
    }
  }
  return null;
}

// A filename from a stranger is used for exactly one thing: telling the person
// who downloads it what the file was called. It never touches a path.
function safeName(name, ext) {
  const base = String(name || "file")
    .replace(/[\r\n"\\]/g, "")
    .replace(/[^\w .()\-]/g, "")
    // Runs of dots collapse and leading dots go: a path walk that has had
    // its slashes stripped should not leave "....etcpasswd" behind either.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "file";
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "file";
  return stem + "." + ext;
}

function storagePath(appId, fileId, ext) {
  return `${appId}/${fileId}.${ext}`;
}

function registerAppFileRoutes(router, { supabaseAdmin, requireAppAuth, express }) {
  // Raw body, not multipart: one file per request keeps the parser trivial, and
  // there is no multipart dependency in this project to reach for.
  const raw = express.raw({ type: "*/*", limit: MAX_FILE_BYTES + 1024 });

  router.post("/files", requireAppAuth, raw, async (req, res) => {
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) {
        return res.status(400).json({ error: "Send the file as the request body." });
      }
      if (body.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: `File too large — the limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB.` });
      }
      const kind = sniff(body);
      if (!kind) {
        return res.status(415).json({
          error: "That file type isn't accepted. Allowed: PNG, JPEG, GIF, WebP and PDF.",
        });
      }

      const appId = req.vibesafeAppId;
      const { data: usage, error: usageError } = await supabaseAdmin
        .from("app_files")
        .select("bytes")
        .eq("app_id", appId);
      if (usageError) throw usageError;
      const count = (usage || []).length;
      const total = (usage || []).reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
      if (count >= MAX_FILES_PER_APP) {
        return res.status(403).json({ error: `This app has reached its ${MAX_FILES_PER_APP}-file limit.` });
      }
      if (total + body.length > MAX_BYTES_PER_APP) {
        return res.status(403).json({ error: "This app has reached its storage limit." });
      }

      const fileId = require("crypto").randomUUID();
      const path = storagePath(appId, fileId, kind.ext);
      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, body, { contentType: kind.mime, upsert: false });
      if (uploadError) throw uploadError;

      const name = safeName(req.header("x-file-name"), kind.ext);
      const { error: metaError } = await supabaseAdmin.from("app_files").insert({
        id: fileId,
        app_id: appId,
        owner_id: req.vibesafeUserId || null,
        name,
        mime: kind.mime,
        bytes: body.length,
        path,
      });
      if (metaError) {
        // Do not leave an orphan in storage that nothing references.
        try { await supabaseAdmin.storage.from(BUCKET).remove([path]); } catch {}
        throw metaError;
      }

      res.status(201).json({
        id: fileId,
        name,
        mime: kind.mime,
        bytes: body.length,
        url: `/api/backend/files/${fileId}`,
      });
    } catch (err) {
      console.error("File upload failed:", err.message);
      res.status(503).json({ error: "Could not store that file. Try again." });
    }
  });

  // Reading is deliberately open to anyone holding the link, like any other
  // asset on a public page - the app's own code decides what to show. The id is
  // a random UUID, so it cannot be guessed or walked.
  router.get("/files/:id", async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "Not found." });
      const { data: meta, error } = await supabaseAdmin
        .from("app_files")
        .select("path, mime, name, bytes")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!meta) return res.status(404).json({ error: "Not found." });

      const { data: blob, error: dlError } = await supabaseAdmin.storage.from(BUCKET).download(meta.path);
      if (dlError || !blob) return res.status(404).json({ error: "Not found." });
      const buffer = Buffer.from(await blob.arrayBuffer());

      res.set("Content-Type", meta.mime);
      res.set("Content-Length", String(buffer.length));
      // nosniff plus an explicit disposition: even though the type was decided
      // by inspecting the bytes, nothing here should ever be treated as a
      // document the browser will execute in our origin.
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Disposition", `inline; filename="${meta.name.replace(/"/g, "")}"`);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.send(buffer);
    } catch (err) {
      console.error("File download failed:", err.message);
      res.status(404).json({ error: "Not found." });
    }
  });

  router.delete("/files/:id", requireAppAuth, async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "Not found." });
      const { data: meta, error } = await supabaseAdmin
        .from("app_files")
        .select("path")
        .eq("id", req.params.id)
        .eq("app_id", req.vibesafeAppId)
        .maybeSingle();
      if (error) throw error;
      if (!meta) return res.status(404).json({ error: "Not found." });
      try { await supabaseAdmin.storage.from(BUCKET).remove([meta.path]); } catch {}
      await supabaseAdmin.from("app_files").delete().eq("id", req.params.id).eq("app_id", req.vibesafeAppId);
      res.json({ deleted: true });
    } catch (err) {
      console.error("File delete failed:", err.message);
      res.status(503).json({ error: "Could not delete that file." });
    }
  });
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_FILES_PER_APP,
  MAX_BYTES_PER_APP,
  BUCKET,
  ALLOWED,
  sniff,
  safeName,
  storagePath,
  registerAppFileRoutes,
};
