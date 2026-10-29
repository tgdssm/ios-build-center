import os from 'node:os';

// Never let a token, a key or the owner's home path reach the browser.
const PATTERNS = [
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]'],
  [/(password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer)(["'\s:=]+)([^\s"',]{6,})/gi, '$1$2[redacted]'],
  [/https?:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://[redacted]@'],
  [/\b[A-Za-z0-9]{52}\b/g, '[redacted-pat]'], // Azure DevOps PAT shape
];

const literals = new Set();

/** Register exact secret values (e.g. every value in the build env) for masking. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.trim().length >= 6) literals.add(value.trim());
}

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const value of literals) out = out.split(value).join('[redacted]');
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  // Personal paths: keep the leaf, drop the home prefix.
  out = out.split(os.homedir()).join('~');
  return out;
}
