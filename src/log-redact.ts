/**
 * Defense-in-depth secret redaction for log lines.
 *
 * Mirrors ChatCSE's `app/log_redaction.py`: the same regex set, applied
 * automatically at the logger boundary so an accidental
 * `log.info("user said " + value)` doesn't leak. Call sites should still
 * never serialize secrets in the first place — this is the safety net.
 *
 * Patterns scrubbed:
 *   - JWTs (header.payload.signature, base64url)
 *   - `Authorization: Bearer <token>` and bare bearer tokens
 *   - Composio keys (`ak_…`, `ck_…`)
 *   - Edstem-style tokens (`prefix.body`, alnum + dot)
 *   - `KNOWN_KEY=value` env-style strings (CHATCSE_AGENT_TOKEN,
 *     ED_API_TOKEN, COMPOSIO_API_KEY, GRADESCOPE_PASSWORD, etc.)
 */

// Order matters — more specific patterns first.
const REDACTORS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWT (3-segment base64url) — matches our agent_tokens and Supabase JWTs.
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '<redacted-jwt>',
  },
  // Bearer tokens (header form).
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi,
    replacement: '$1<redacted-bearer>',
  },
  // Composio API keys.
  {
    pattern: /\b(ak|ck)_[A-Za-z0-9]{16,}\b/g,
    replacement: '<redacted-composio-key>',
  },
  // Edstem-style `prefix.body` tokens (4-8 char prefix, 30-80 char body).
  {
    pattern: /\b[A-Za-z0-9]{4,8}\.[A-Za-z0-9]{30,80}\b/g,
    replacement: '<redacted-ed-token>',
  },
  // Generic env-var-style: KEY=value where KEY is one we recognize as a secret.
  {
    pattern:
      /\b(ED_API_TOKEN|CANVAS_API_TOKEN|GRADESCOPE_PASSWORD|COMPOSIO_API_KEY|CHATCSE_AGENT_TOKEN|AGENT_TOKEN_SIGNING_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SUPABASE_JWT_SECRET|GOOGLE_API_KEY|DISCORD_BOT_TOKEN|SECRET_KEY)\s*[:=]\s*\S+/gi,
    replacement: '$1=<redacted>',
  },
];

/** Apply all redactors to a string. Idempotent. */
export function redactString(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACTORS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Recursively redact strings inside arbitrary log payloads. Handles
 * dicts/arrays so a `log.info("x", { user: { password: "Bearer eyJ..." } })`
 * call still gets scrubbed all the way down.
 *
 * Errors get their `message` and `stack` redacted but the Error object
 * shape is preserved (the formatter at the log boundary expects an Error
 * instance, not a plain object).
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    // Preserve Error identity so log.ts's formatErr keeps working.
    const e = new (value.constructor as ErrorConstructor)(redactString(value.message));
    if (value.stack) e.stack = redactString(value.stack);
    return e;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}
