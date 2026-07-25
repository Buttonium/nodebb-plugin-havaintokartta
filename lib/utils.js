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
  normalizeCoordinate,
  parsePositiveInteger,
  safeFileSegment,
  sanitizeMultilineText,
  sanitizeSingleLineText,
  toBoolean,
  toNullableString,
};
