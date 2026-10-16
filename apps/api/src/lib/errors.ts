export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const validationError = (details: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', 'Some details need your attention', details);
export const unauthorized = (message = 'Please sign in to continue') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'We could not find that') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
export const tooManyRequests = (message = 'Too many attempts. Please try again shortly') =>
  new AppError(429, 'RATE_LIMITED', message);
