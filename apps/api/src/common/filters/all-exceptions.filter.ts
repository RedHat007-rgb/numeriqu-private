import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { randomUUID } from 'crypto';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) return;

    const traceId = randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const normalizedPayload = payload as Record<string, unknown>;
        const message = this.extractMessage(normalizedPayload);
        const code = this.extractCode(normalizedPayload, status);
        this.logByStatus(status, `[${code}] ${message} traceId=${traceId}`);
        response.status(status).json({ message, code, traceId });
        return;
      }

      const message = typeof payload === 'string' ? payload : 'Request failed.';
      const code = this.defaultCode(status);
      this.logByStatus(status, `[${code}] ${message} traceId=${traceId}`);
      response.status(status).json({ message, code, traceId });
      return;
    }

    const message = 'Something went wrong. Please try again.';
    const code = 'INTERNAL_ERROR';

    if (exception instanceof Error) {
      this.logger.error(`[${code}] traceId=${traceId} ${exception.message}`, exception.stack);
    } else {
      this.logger.error(`[${code}] traceId=${traceId} ${JSON.stringify(exception)}`);
    }

    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ message, code, traceId });
  }

  private extractMessage(payload: Record<string, unknown>) {
    const raw = payload.message;
    if (Array.isArray(raw)) return raw.join(', ');
    if (typeof raw === 'string') return raw;
    return 'Request failed.';
  }

  private extractCode(payload: Record<string, unknown>, status: number) {
    const raw = payload.code;
    if (typeof raw === 'string' && raw) return raw;
    return this.defaultCode(status);
  }

  private defaultCode(status: number) {
    if (status === HttpStatus.BAD_REQUEST) return 'BAD_REQUEST';
    if (status === HttpStatus.UNAUTHORIZED) return 'UNAUTHORIZED';
    if (status === HttpStatus.FORBIDDEN) return 'FORBIDDEN';
    if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND';
    if (status === HttpStatus.CONFLICT) return 'CONFLICT';
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'RATE_LIMITED';
    if (status >= 500) return 'INTERNAL_ERROR';
    return 'REQUEST_FAILED';
  }

  private logByStatus(status: number, text: string) {
    if (status >= 500) this.logger.error(text);
    else this.logger.warn(text);
  }
}
