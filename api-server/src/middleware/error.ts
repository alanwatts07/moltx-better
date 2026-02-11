import { Request, Response, NextFunction } from "express";

/**
 * Async error handler wrapper
 * Catches async errors and passes to Express error middleware
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
