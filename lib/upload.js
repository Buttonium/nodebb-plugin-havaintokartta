'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const Busboy = require('busboy');

const { getConfig } = require('./config');
const errors = require('./errors');
const { safeFileSegment } = require('./utils');

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const MIME_TYPE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function isAllowedMimeType(mimeType) {
  const normalized = String(mimeType ?? '').trim().toLowerCase();
  return ALLOWED_MIME_TYPES.has(normalized);
}

function getExtension(filename, mimeType) {
  void filename;

  return MIME_TYPE_EXTENSIONS[String(mimeType ?? '').trim().toLowerCase()] || 'bin';
}

/**
 * Check the file's leading bytes match its declared MIME type.
 */
const MAGIC_NUMBERS = {
  'image/jpeg': [
    [0xFF, 0xD8, 0xFF],
  ],
  'image/png': [
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  ],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  'image/webp': [
    // RIFF....WEBP — bytes 0-3 are RIFF, bytes 8-11 are WEBP
    [0x52, 0x49, 0x46, 0x46],
  ],
  'image/heic': [
    // HEIC/HEIF use ISO BMFF; "ftyp" box at offset 4, brand "heic"/"heix"/"mif1" at offset 8
    [0x68, 0x65, 0x69, 0x63], // "heic"
    [0x68, 0x65, 0x69, 0x78], // "heix"
    [0x6D, 0x69, 0x66, 0x31], // "mif1"
  ],
  'image/heif': [
    [0x68, 0x65, 0x69, 0x63], // "heic"
    [0x68, 0x65, 0x69, 0x78], // "heix"
    [0x6D, 0x69, 0x66, 0x31], // "mif1"
  ],
};

function matchesMagicBytes(buffer, mimeType) {
  const signatures = MAGIC_NUMBERS[mimeType];
  if (!signatures) {
    // No signature defined — allow (shouldn't happen for whitelisted types)
    return true;
  }

  return signatures.some((signature) => {
    if (buffer.length < signature.length) {
      return false;
    }

    // WebP: check RIFF header at start AND "WEBP" at offset 8
    if (mimeType === 'image/webp') {
      if (buffer.length < 12) return false;
      return buffer[0] === 0x52 && buffer[1] === 0x49 &&
             buffer[2] === 0x46 && buffer[3] === 0x46 &&
             buffer[8] === 0x57 && buffer[9] === 0x45 &&
             buffer[10] === 0x42 && buffer[11] === 0x50;
    }

    // HEIC/HEIF: "ftyp" box at offset 4, brand at offset 8
    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
      if (buffer.length < 12) return false;
      // Check "ftyp" at offset 4
      if (!(buffer[4] === 0x66 && buffer[5] === 0x74 &&
            buffer[6] === 0x79 && buffer[7] === 0x70)) {
        return false;
      }
      // Check brand at offset 8
      return signature.every((byte, i) => buffer[8 + i] === byte);
    }

    // JPEG, PNG, GIF: check signature at offset 0
    return signature.every((byte, i) => buffer[i] === byte);
  });
}

async function parseSingleFile(req) {
  const { maxUploadBytes } = getConfig();

  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: maxUploadBytes,
        // Cap parts/fields to stop multipart floods; callers only send one file.
        parts: 2,
        fields: 1,
      },
    });

    const chunks = [];
    let fileFound = false;
    let fileInfo = null;
    let fileTooLarge = false;

    busboy.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file') {
        stream.resume();
        return;
      }

      fileFound = true;
      fileInfo = info;

      if (!isAllowedMimeType(info?.mimeType)) {
        stream.resume();
        return;
      }

      stream.on('limit', () => {
        fileTooLarge = true;
        stream.resume(); // fast-forward through remaining data without buffering
      });

      stream.on('data', (chunk) => {
        if (!fileTooLarge) {
          chunks.push(chunk);
        }
        // If fileTooLarge, silently consume the stream without storing chunks
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      if (!fileFound) {
        reject(errors.badRequest('file is required.'));
        return;
      }

      if (fileTooLarge) {
        reject(errors.badRequest('Uploaded file is too large.'));
        return;
      }

      if (!isAllowedMimeType(fileInfo?.mimeType)) {
        reject(errors.badRequest('Uploaded file must be a JPEG, PNG, WebP, GIF, HEIC, or HEIF image.'));
        return;
      }

      const buffer = Buffer.concat(chunks);
      const normalizedMimeType = String(fileInfo.mimeType).trim().toLowerCase();

      if (!matchesMagicBytes(buffer, normalizedMimeType)) {
        reject(errors.badRequest('File content does not match its declared type.'));
        return;
      }

      resolve({
        buffer,
        filename: fileInfo?.filename || 'upload.bin',
        mimeType: fileInfo?.mimeType || 'application/octet-stream',
      });
    });

    req.pipe(busboy);
  });
}

// ── Generic upload/delete ──────────────────────────────────────
// All image types share this logic; only the directory/URL prefix differ.

async function uploadImage(req, directory, urlPrefix) {
  const { baseUrl } = getConfig();
  const file = await parseSingleFile(req);
  const extension = getExtension(file.filename, file.mimeType);
  const dateSegment = new Date().toISOString().slice(0, 10);
  const rawFileName = `${Date.now()}-${randomUUID()}.${extension}`;
  const fileName = safeFileSegment(rawFileName);
  const diskDirectory = path.join(directory, dateSegment);
  const diskPath = path.join(diskDirectory, fileName);

  await fs.mkdir(diskDirectory, { recursive: true });
  await fs.writeFile(diskPath, file.buffer);

  const relativePath = `${urlPrefix}/${dateSegment}/${fileName}`;

  return {
    path: baseUrl ? `${baseUrl}${relativePath}` : relativePath,
  };
}

async function deleteImage(imageUrl, directory, urlPrefix) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
    return false;
  }

  let pathname;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    console.warn('[havaintokartta] deleteImage: invalid URL:', imageUrl);
    return false;
  }

  const normalizedPrefix = String(urlPrefix ?? '').trim().replace(/\/+$/, '');
  const expectedPrefix = `/${normalizedPrefix.replace(/^\/+/, '')}`;

  if (!pathname.startsWith(expectedPrefix)) {
    console.warn('[havaintokartta] deleteImage: URL does not match uploads prefix:', imageUrl);
    return false;
  }

  const relativePath = pathname.slice(expectedPrefix.length).replace(/^\/+/, '');

  if (relativePath.includes('..')) {
    console.warn('[havaintokartta] deleteImage: path traversal detected:', imageUrl);
    return false;
  }

  const diskPath = path.join(directory, relativePath);
  const resolvedPath = path.resolve(diskPath);
  const resolvedBase = path.resolve(directory);

  if (!resolvedPath.startsWith(resolvedBase)) {
    console.warn('[havaintokartta] deleteImage: path escapes uploads directory:', diskPath);
    return false;
  }

  try {
    await fs.unlink(resolvedPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[havaintokartta] deleteImage: file already gone:', resolvedPath);
    } else {
      console.error('[havaintokartta] deleteImage: failed to delete:', err?.message || err);
    }
    return false;
  }
}

// ── Thin wrappers (preserve existing API) ──────────────────────

function uploadReportImage(req) {
  const { uploadsDirectory, uploadsUrlPrefix } = getConfig();
  return uploadImage(req, uploadsDirectory, uploadsUrlPrefix);
}

function deleteReportImage(imageUrl) {
  const { uploadsDirectory, uploadsUrlPrefix } = getConfig();
  return deleteImage(imageUrl, uploadsDirectory, uploadsUrlPrefix);
}

function uploadNewsImage(req) {
  const { newsUploadsDirectory, newsUploadsUrlPrefix } = getConfig();
  return uploadImage(req, newsUploadsDirectory, newsUploadsUrlPrefix);
}

function deleteNewsImage(imageUrl) {
  const { newsUploadsDirectory, newsUploadsUrlPrefix } = getConfig();
  return deleteImage(imageUrl, newsUploadsDirectory, newsUploadsUrlPrefix);
}

function uploadEventImage(req) {
  const { eventUploadsDirectory, eventUploadsUrlPrefix } = getConfig();
  return uploadImage(req, eventUploadsDirectory, eventUploadsUrlPrefix);
}

function deleteEventImage(imageUrl) {
  const { eventUploadsDirectory, eventUploadsUrlPrefix } = getConfig();
  return deleteImage(imageUrl, eventUploadsDirectory, eventUploadsUrlPrefix);
}

function uploadServiceImage(req) {
  const { serviceUploadsDirectory, serviceUploadsUrlPrefix } = getConfig();
  return uploadImage(req, serviceUploadsDirectory, serviceUploadsUrlPrefix);
}

function deleteServiceImage(imageUrl) {
  const { serviceUploadsDirectory, serviceUploadsUrlPrefix } = getConfig();
  return deleteImage(imageUrl, serviceUploadsDirectory, serviceUploadsUrlPrefix);
}

module.exports = {
  deleteReportImage,
  uploadReportImage,
  uploadNewsImage,
  deleteNewsImage,
  uploadEventImage,
  deleteEventImage,
  uploadServiceImage,
  deleteServiceImage,
};
