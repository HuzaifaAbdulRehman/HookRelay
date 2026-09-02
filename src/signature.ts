import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';

const PREFIX = 'sha256=';
const DIGEST_BYTES = 32;

export function sign(body: Buffer, secret: string): string {
  return PREFIX + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Compares a `sha256=<hex>` header against the body.
 *
 * The length check is what actually rejects a malformed digest: `Buffer.from`
 * silently truncates invalid hex, and `timingSafeEqual` throws rather than
 * returning false when the lengths differ.
 */
export function verifySignature(body: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith(PREFIX)) return false;

  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  if (received.length !== DIGEST_BYTES) return false;

  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(received, expected);
}
