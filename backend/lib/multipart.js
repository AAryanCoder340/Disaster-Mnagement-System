const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];

function parseBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return m ? (m[1] || m[2]).trim() : null;
}

function findAll(buf, needle) {
  const out = [];
  if (!Buffer.isBuffer(buf) || !needle.length) return out;
  let idx = 0;
  while (true) {
    const found = buf.indexOf(needle, idx);
    if (found === -1) break;
    out.push(found);
    idx = found + 1;
  }
  return out;
}

function splitHeaderBody(partBuf) {
  const sep = Buffer.from('\r\n\r\n');
  const pos = partBuf.indexOf(sep);
  if (pos === -1) return { headerBuf: partBuf, bodyBuf: Buffer.alloc(0) };
  return {
    headerBuf: partBuf.subarray(0, pos),
    bodyBuf: partBuf.subarray(pos + sep.length)
  };
}

function parseContentDisposition(headerBuf) {
  const header = headerBuf.toString('utf8');
  const cd = header.split(/\r\n/).find((h) => /^content-disposition:/i.test(h));
  if (!cd) return { name: null, filename: null };
  const nameMatch = /name="?([^";]+)"?/i.exec(cd);
  const fileMatch = /filename="?([^";]+)"?/i.exec(cd);
  return {
    name: nameMatch ? nameMatch[1] : null,
    filename: fileMatch ? fileMatch[1] : null
  };
}

function parseContentType(headerBuf) {
  const header = headerBuf.toString('utf8');
  const ct = header.split(/\r\n/).find((h) => /^content-type:/i.test(h));
  if (!ct) return 'application/octet-stream';
  const m = /content-type:\s*([^;\r\n]+)/i.exec(ct);
  return m ? m[1].trim() : 'application/octet-stream';
}

async function readStreamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    stream.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        reject(new Error(`Request body too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks, total));
    });
    stream.on('error', reject);
  });
}

async function parseMultipartForm(req, options = {}) {
  const maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  const maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
  const allowedPrefixes = options.allowedMimePrefixes || ALLOWED_MIME_PREFIXES;

  const boundary = parseBoundary(req.headers['content-type']);
  if (!boundary) {
    throw new Error('Missing multipart boundary in Content-Type');
  }

  const body = await readStreamToBuffer(req, maxBodyBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelim = Buffer.from(`--${boundary}--`);

  const positions = findAll(body, delimiter);
  const form = new Map();
  const files = [];

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i] + delimiter.length;
    const next = positions[i + 1];
    if (next === undefined) break;
    let end = next;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) {
      // skip CRLF after delimiter
    }
    const raw = body.subarray(start, end);
    let trimmed = raw;
    if (trimmed.subarray(0, 2).equals(Buffer.from('\r\n'))) {
      trimmed = trimmed.subarray(2);
    }
    if (trimmed.subarray(trimmed.length - 2).equals(Buffer.from('\r\n'))) {
      trimmed = trimmed.subarray(0, trimmed.length - 2);
    }
    if (trimmed.subarray(trimmed.length - 4).equals(Buffer.from('\r\n--'))) {
      trimmed = trimmed.subarray(0, trimmed.length - 4);
    }
    if (trimmed.equals(Buffer.from('--'))) continue;
    if (trimmed.subarray(0, 2).equals(Buffer.from('--'))) continue;
    if (trimmed.length === 0) continue;

    const { headerBuf, bodyBuf } = splitHeaderBody(trimmed);
    const { name, filename } = parseContentDisposition(headerBuf);
    if (!name) continue;

    if (filename !== null && filename !== undefined) {
      const contentType = parseContentType(headerBuf);
      if (bodyBuf.length > maxFileBytes) {
        throw new Error(`File "${filename}" exceeds max file size (${Math.round(maxFileBytes / 1024 / 1024)}MB)`);
      }
      const allowed = allowedPrefixes.some((p) => contentType.startsWith(p));
      files.push({
        fieldName: name,
        originalName: filename,
        contentType: allowed ? contentType : 'application/octet-stream',
        size: bodyBuf.length,
        buffer: bodyBuf
      });
    } else {
      let value;
      try {
        value = bodyBuf.toString('utf8');
        if (value.startsWith('{') || value.startsWith('[')) {
          value = JSON.parse(value);
        }
      } catch (_) {
        value = bodyBuf.toString('utf8');
      }
      if (!form.has(name)) form.set(name, []);
      form.get(name).push(value);
    }
  }

  const fields = {};
  for (const [k, v] of form.entries()) {
    fields[k] = v.length === 1 ? v[0] : v;
  }

  return { fields, files };
}

function ensureUploadDir(uploadRoot) {
  fs.mkdirSync(uploadRoot, { recursive: true });
  const byDate = path.join(uploadRoot, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(byDate, { recursive: true });
  return byDate;
}

function persistUploadedFile({ originalName, contentType, size, buffer, uploadRoot }) {
  const targetDir = ensureUploadDir(uploadRoot);
  const ext = (path.extname(originalName) || '').slice(0, 10);
  const base = `${crypto.randomBytes(10).toString('hex')}${ext}`;
  const fullPath = path.join(targetDir, base);
  fs.writeFileSync(fullPath, buffer);
  const relative = path.relative(path.join(uploadRoot, '..'), fullPath).replace(/\\/g, '/');
  return {
    storedName: base,
    storagePath: fullPath,
    relativePath: relative
  };
}

module.exports = {
  parseMultipartForm,
  persistUploadedFile,
  ensureUploadDir,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES
};
