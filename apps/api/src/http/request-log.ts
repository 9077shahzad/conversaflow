import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type LogSink = (line: string) => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One structured JSON line per request, with a correlation id returned as X-Request-Id.
 * Deliberately never logged: query strings (download links carry signed tokens), request or response bodies,
 * cookies, authorisation headers, email addresses. Path segments that look like ids are kept (they are not secret);
 * the company id is attached by the guard when known, for tenant-scoped incident search.
 */
export function requestLog(sink: LogSink = (l) => process.stdout.write(l + '\n')) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && UUID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const r = req as Request & { cfSession?: { userId: string }; cfActor?: { tenantId: string } };
      sink(JSON.stringify({
        t: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        requestId: id,
        method: req.method,
        path: req.path, // no query string
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        userId: r.cfSession?.userId,
        tenantId: r.cfActor?.tenantId,
      }));
    });
    next();
  };
}
