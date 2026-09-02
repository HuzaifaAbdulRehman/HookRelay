import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact body bytes off the wire. Only set on routes inside `rawBodyPlugin`. */
    rawBody?: Buffer;
  }
}

export function requireRawBody(request: FastifyRequest): Buffer {
  const raw = request.rawBody;
  if (raw === undefined) throw new Error('rawBody is not available on this route');
  return raw;
}

export interface RawBodyOptions {
  bodyLimit: number;
}

/**
 * Keeps the original bytes alongside the parsed body.
 *
 * `parseAs: 'string'` cannot be used here: Fastify calls `setEncoding('utf8')`
 * unconditionally, so a byte outside UTF-8 becomes a three-byte replacement
 * character and the request dies on a content-length mismatch before any
 * handler runs. Signatures are computed over the bytes a provider sent, so the
 * body has to survive as a Buffer.
 *
 * Parsing is delegated to Fastify's own JSON parser rather than `JSON.parse`,
 * which keeps prototype-poisoning protection and the 400 on an empty body.
 *
 * Call this on the scope that owns the routes, not through `app.register`.
 * Registering would put the parsers in a child context that the caller's own
 * routes cannot see. Content-type parsers do not leak upward out of a scope, so
 * an encapsulated caller still keeps them away from the rest of the app.
 */
export function applyRawBodyParsers(app: FastifyInstance, opts: RawBodyOptions): void {
  app.decorateRequest('rawBody', undefined);

  const parseJson = app.getDefaultJsonParser('error', 'error');

  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer', bodyLimit: opts.bodyLimit },
    (request, body, done) => {
      request.rawBody = body;
      parseJson(request, body.toString('utf8'), done);
    },
  );

  app.addContentTypeParser<Buffer>(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer', bodyLimit: opts.bodyLimit },
    (request, body, done) => {
      request.rawBody = body;

      if (body.length === 0) {
        done(null, {});
        return;
      }

      // GitHub's form mode wraps the JSON in a `payload` field. The signature
      // still covers the whole urlencoded body, which is why the raw buffer is
      // captured before any of this.
      const params = new URLSearchParams(body.toString('utf8'));
      const payload = params.get('payload');
      if (payload === null) {
        done(null, Object.fromEntries(params));
        return;
      }
      parseJson(request, payload, done);
    },
  );
}
