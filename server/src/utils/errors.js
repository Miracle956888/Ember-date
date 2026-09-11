/** Application error with an HTTP status and a safe, user-facing message. */
export class AppError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = options.code || undefined;
    this.details = options.details || undefined;
    this.expose = true;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (msg = 'Invalid request.', o) => new AppError(400, msg, o);
export const unauthorized = (msg = 'You need to sign in to do that.', o) => new AppError(401, msg, o);
export const forbidden = (msg = "You don't have access to that.", o) => new AppError(403, msg, o);
export const notFound = (msg = 'Not found.', o) => new AppError(404, msg, o);
export const conflict = (msg = 'That conflicts with something that already exists.', o) => new AppError(409, msg, o);
export const tooLarge = (msg = 'That file is too large.', o) => new AppError(413, msg, o);
export const unsupported = (msg = 'That file type is not supported.', o) => new AppError(415, msg, o);
export const tooMany = (msg = 'Slow down a moment and try again.', o) => new AppError(429, msg, o);

/** Wrap an async express handler so rejections reach the error middleware. */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default AppError;
