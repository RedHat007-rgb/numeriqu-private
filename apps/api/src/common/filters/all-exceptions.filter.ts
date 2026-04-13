import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected system error occurred. Please try again later.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responsePayload = exception.getResponse();
      
      // Pass through validation errors or user-friendly messages
      if (typeof responsePayload === 'string') {
        message = responsePayload;
      } else if (typeof responsePayload === 'object' && responsePayload !== null) {
        // If it's a validation error array or similar standard Nest response
        const anyPayload = responsePayload as any;
        if (anyPayload.message) {
           message = Array.isArray(anyPayload.message) ? anyPayload.message.join(', ') : anyPayload.message;
        }
      }
    } else if (exception instanceof Error) {
      // Log the actual technical error to the server console only
      this.logger.error(`Critical unexpected exception: ${exception.message}`, exception.stack);
    } else {
      this.logger.error(`Unknown exception type: ${JSON.stringify(exception)}`);
    }

    // Never leak DB identifiers, stack traces, or raw Node errors to the client.
    response.status(status).json({
      statusCode: status,
      message: message, // Client-safe message only
      error: HttpStatus[status] || 'Internal Error',
    });
  }
}
