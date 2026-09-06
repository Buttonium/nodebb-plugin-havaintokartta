'use strict';

function parsePositiveInteger(value, fallbackValue = 0) {
  const parsedValue = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

function sanitizeSingleLineText(value, maxLength) {
  const normalizedValue = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!maxLength || normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return normalizedValue.slice(0, maxLength).trim();
}

function sanitizeMultilineText(value, maxLength) {
  const normalizedValue = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    // Collapse runs of 3+ newlines into double newline (preserve paragraph breaks)
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();

  if (!maxLength || normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return normalizedValue.slice(0, maxLength).trim();
}

function normalizeCoordinate(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalizedValue = String(value ?? '').trim().toLowerCase();
  return normalizedValue === '1' || normalizedValue === 'true';
}

function toNullableString(value) {
  const normalizedValue = String(value ?? '').trim();
  return normalizedValue ? normalizedValue : null;
}

function buildTopicUrl(baseUrl, tid, slug) {
  const normalizedBaseUrl = String(baseUrl ?? '').trim().replace(/\/$/, '');
  const normalizedSlug = String(slug ?? '').trim().replace(/^\/+/, '').replace(/^topic\//, '');

  if (!normalizedBaseUrl) {
    return normalizedSlug ? `/topic/${normalizedSlug}` : `/topic/${tid}`;
  }

  if (/^\d+\//.test(normalizedSlug)) {
    return `${normalizedBaseUrl}/topic/${normalizedSlug}`;
  }

  if (normalizedSlug) {
    return `${normalizedBaseUrl}/topic/${tid}/${normalizedSlug}`;
  }

  return `${normalizedBaseUrl}/topic/${tid}`;
}

const MAX_REPORT_IMAGES = 5;

/**
 * Parse a report images value into a normalized array of URL strings.
 * Accepts the stored JSON array string, an actual array (optionally of
 * {url} objects), or a legacy bare URL/path string. Dedupes and drops
 * anything that is not an http(s) or absolute-path URL.
 */
function parseReportImageUrls(value, maxImages = MAX_REPORT_IMAGES) {
  const urls = [];
  const seen = new Set();

  const push = (entry) => {
    const candidateEntry = entry && typeof entry === 'object' ? entry.url : entry;
    if (typeof candidateEntry !== 'string') return;
    const url = candidateEntry.trim();
    if (!url || seen.has(url)) return;
    if (!/^(?:https?:\/\/|\/)/i.test(url)) return;
    seen.add(url);
    urls.push(url);
  };

  if (Array.isArray(value)) {
    for (const entry of value) push(entry);
    return urls.slice(0, maxImages);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        for (const entry of Array.isArray(parsed) ? parsed : []) push(entry);
        return urls.slice(0, maxImages);
      } catch {
        return [];
      }
    }
    push(trimmed);
    return urls.slice(0, maxImages);
  }

  return [];
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function safeFileSegment(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'file';
}

module.exports = {
  buildTopicUrl,
  formatBytes,
  MAX_REPORT_IMAGES,
  normalizeCoordinate,
  parsePositiveInteger,
  parseReportImageUrls,
  safeFileSegment,
  sanitizeMultilineText,
  sanitizeSingleLineText,
  toBoolean,
  toNullableString,
};
