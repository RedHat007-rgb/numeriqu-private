import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * AllExceptionsFilter — Production-Grade Global Error Boundary
 *
 * DESIGN PRINCIPLE:
 * The user should NEVER see a stack trace, a DB error, or a raw Node exception.
 * Every technical error is mapped to a human-readable, actionable message.
 *
 * The raw error is logged server-side for engineering debugging.
 * The user gets a clean, professional response every time.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Guard: If response is already sent (e.g., SSE stream ended), skip
    if (response.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message =
      'Something went wrong. Our team has been notified and is looking into it.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responsePayload = exception.getResponse();

      if (typeof responsePayload === 'string') {
        message = responsePayload;
      } else if (
        typeof responsePayload === 'object' &&
        responsePayload !== null
      ) {
        const payload = responsePayload as any;
        if (payload.message) {
          message = Array.isArray(payload.message)
            ? payload.message.join(', ')
            : payload.message;
        }
      }

      // Log 4xx as warnings, not errors
      if (status >= 400 && status < 500) {
        this.logger.warn(`[${status}] ${message}`);
      } else {
        this.logger.error(`[${status}] ${message}`);
      }
    } else if (exception instanceof Error) {
      // ── Domain-Specific Error Mapping ──────────────────────────────────
      // Map technical errors to user-friendly messages
      const raw = exception.message || '';
      const stack = exception.stack || '';

      this.logger.error(`Unhandled: ${raw}`, stack);

      // ClickHouse errors
      if (
        raw.includes('ECONNREFUSED') &&
        (raw.includes('8123') ||
          raw.includes('9000') ||
          raw.includes('clickhouse'))
      ) {
        message =
          'Our analytics engine is temporarily unavailable. Your data is safe — please try again in a moment.';
        status = HttpStatus.SERVICE_UNAVAILABLE;
      }
      // ClickHouse query errors
      else if (
        raw.includes('DB::Exception') ||
        raw.includes('Code: 60') ||
        raw.includes('UNKNOWN_TABLE')
      ) {
        message =
          'Your financial data is being prepared. Please allow a few moments for the initial setup to complete.';
        status = HttpStatus.SERVICE_UNAVAILABLE;
      }
      // Prisma / PostgreSQL errors
      else if (
        raw.includes('PrismaClientKnownRequestError') ||
        raw.includes('P2002') ||
        raw.includes('P2025')
      ) {
        message = 'A data conflict occurred. Please refresh and try again.';
        status = HttpStatus.CONFLICT;
      } else if (raw.includes('PrismaClient') || raw.includes('prisma')) {
        message =
          'We encountered a temporary issue accessing your account data. Please try again.';
        status = HttpStatus.SERVICE_UNAVAILABLE;
      }
      // Ollama / AI engine errors
      else if (
        raw.includes('AI_ENGINE_OFFLINE') ||
        (raw.includes('ECONNREFUSED') && raw.includes('11434'))
      ) {
        message =
          'The AI reasoning engine is warming up. Please try your query again in a moment.';
        status = HttpStatus.SERVICE_UNAVAILABLE;
      }
      // Network / timeout errors
      else if (
        raw.includes('ETIMEDOUT') ||
        raw.includes('ESOCKETTIMEDOUT') ||
        raw.includes('timeout')
      ) {
        message =
          'The request took too long to complete. Please try again with a simpler query.';
        status = HttpStatus.GATEWAY_TIMEOUT;
      }
      // OAuth errors
      else if (
        raw.includes('OAuth') ||
        raw.includes('oauth') ||
        raw.includes('token')
      ) {
        message =
          'Your authorization session has expired. Please reconnect your provider.';
        status = HttpStatus.UNAUTHORIZED;
      }
      // Generic connection errors
      else if (
        raw.includes('ECONNREFUSED') ||
        raw.includes('ENOTFOUND') ||
        raw.includes('fetch failed')
      ) {
        message =
          'A required service is temporarily unavailable. Please try again in a moment.';
        status = HttpStatus.SERVICE_UNAVAILABLE;
      }
    } else {
      this.logger.error(`Unknown exception type: ${JSON.stringify(exception)}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
