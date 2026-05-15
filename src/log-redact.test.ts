/**
 * Tests for the secret-redaction safety net applied at every log emission.
 */
import { describe, expect, it } from 'vitest';

import { redactString, redactValue } from './log-redact.js';

const SECRET_ED = 'hGWOcB.L182I0NxkODB9Aj58FEURAW3lpFd8GEJirOnHzNr';
const SECRET_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4In0.signature_xyz_abc';
const SECRET_COMPOSIO = 'ak_YSJtV1234567890abcdef';

describe('redactString', () => {
  it('scrubs JWTs', () => {
    const out = redactString(`Authorization: Bearer ${SECRET_JWT}`);
    expect(out).not.toContain(SECRET_JWT);
    expect(out).toContain('<redacted-jwt>');
  });

  it('scrubs Composio keys', () => {
    const out = redactString(`COMPOSIO_API_KEY=${SECRET_COMPOSIO}`);
    expect(out).not.toContain(SECRET_COMPOSIO);
  });

  it('scrubs Edstem-style tokens', () => {
    const out = redactString(`ED_API_TOKEN=${SECRET_ED}`);
    expect(out).not.toContain('L182I0Nxk');
  });

  it('scrubs Bearer header tokens', () => {
    const out = redactString('Authorization: Bearer abcdef1234567890ABCDEF1234567890');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('<redacted-bearer>');
  });

  it('is idempotent', () => {
    const once = redactString(`Bearer ${SECRET_JWT}`);
    const twice = redactString(once);
    expect(once).toBe(twice);
  });

  it('leaves non-secret text alone', () => {
    const msg = 'User vinamra connected via Discord (id 1143424326331285504)';
    expect(redactString(msg)).toBe(msg);
  });
});

describe('redactValue', () => {
  it('scrubs strings inside nested dicts', () => {
    const v = { user: { name: 'alice', cred: `Bearer ${SECRET_JWT}` } };
    const out = redactValue(v) as typeof v;
    expect(out.user.name).toBe('alice');
    expect(out.user.cred).not.toContain(SECRET_JWT);
  });

  it('scrubs strings inside arrays', () => {
    const v = ['safe', `ED_API_TOKEN=${SECRET_ED}`, 42];
    const out = redactValue(v) as unknown[];
    expect(out[0]).toBe('safe');
    expect(out[1]).not.toContain('L182I0Nxk');
    expect(out[2]).toBe(42);
  });

  it('preserves null/undefined/numbers/booleans', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });

  it('redacts Error message + stack while preserving Error identity', () => {
    const err = new Error(`failed with token ${SECRET_JWT}`);
    const out = redactValue(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).not.toContain(SECRET_JWT);
    if (out.stack) expect(out.stack).not.toContain(SECRET_JWT);
  });
});
