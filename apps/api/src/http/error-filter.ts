import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../core/errors';

/** Every error leaves the API in one shape, and internal details never reach the caller. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('api');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = status === 413 ? 'too_large' : status === 404 ? 'not_found' : 'bad_request';
      res.status(status).json({ error: { code, message: status === 404 ? 'Not found.' : err.message } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'The request body is too large.' } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON.' } });
      return;
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
  }
}
