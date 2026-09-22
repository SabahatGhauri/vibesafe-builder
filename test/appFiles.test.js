const { test } = require("node:test");
const assert = require("node:assert/strict");
const f = require("../lib/appFiles");

const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const pdf = () => Buffer.from("%PDF-1.7\n stream");
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(8)]);

test("a file's type comes from its bytes, not from what the uploader claimed", () => {
  assert.equal(f.sniff(png()).mime, "image/png");
  assert.equal(f.sniff(jpeg()).mime, "image/jpeg");
  assert.equal(f.sniff(pdf()).mime, "application/pdf");
  assert.equal(f.sniff(webp()).mime, "image/webp");
});

test("anything that could run is refused, however it is dressed up", () => {
  const cases = {
    "html pretending to be a png": Buffer.from('<html><script>alert(1)</script></html>'),
    "svg (can carry script)": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
    "windows executable": Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    "shell script": Buffer.from("#!/bin/sh\nrm -rf /"),
    "zip/office document": Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    "empty": Buffer.alloc(0),
  };
  for (const [label, buf] of Object.entries(cases)) {
    assert.equal(f.sniff(buf), null, label);
  }
});

test("RIFF alone is not enough to pass as WebP", () => {
  // RIFF is also AVI and WAV; the second marker is what makes it an image.
  const avi = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("AVI "), Buffer.alloc(8)]);
  assert.equal(f.sniff(avi), null);
});

test("a filename from a stranger can never become a path", () => {
  assert.equal(f.safeName("../../etc/passwd", "png"), "etcpasswd.png");
  assert.equal(f.safeName("cv.pdf", "pdf"), "cv.pdf");
  assert.equal(f.safeName('re"port.pdf', "pdf"), "report.pdf");
  assert.ok(!f.safeName("a/b/c.png", "png").includes("/"));
  assert.ok(!f.safeName("x\r\nContent-Type: text/html", "png").includes("\n"));
});

test("the stored extension always matches the sniffed type", () => {
  // Upload "photo.exe" that is really a PNG and it is stored as .png: the
  // extension describes what the bytes are, never what the name claimed.
  assert.equal(f.safeName("photo.exe", "png"), "photo.png");
  assert.equal(f.safeName("", "pdf"), "file.pdf");
  assert.equal(f.safeName(null, "jpg"), "file.jpg");
});

test("a long filename is bounded", () => {
  assert.ok(f.safeName("x".repeat(500) + ".png", "png").length <= 85);
});

test("every app's files live under its own prefix", () => {
  assert.equal(f.storagePath("app123", "abc-def", "png"), "app123/abc-def.png");
});

test("limits are stated in whole, checkable numbers", () => {
  assert.equal(f.MAX_FILE_BYTES, 2 * 1024 * 1024);
  assert.equal(f.MAX_FILES_PER_APP, 200);
  assert.equal(f.MAX_BYTES_PER_APP, 50 * 1024 * 1024);
  assert.ok(!f.ALLOWED.some((a) => /svg|html/.test(a.mime)), "nothing executable is allowed");
});
