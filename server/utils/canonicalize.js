import crypto from 'crypto';

/**
 * Canonicalizes a JSON object (sort keys recursively)
 */
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const stringified = obj.map(item => canonicalize(item));
    return `[${stringified.join(',')}]`;
  }

  const keys = Object.keys(obj).sort();
  const parts = keys.map(key => {
    const val = canonicalize(obj[key]);
    return `"${key}":${val}`;
  });
  return `{${parts.join(',')}}`;
}

export function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
