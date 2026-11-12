import { NextFunction, Request, Response } from 'express';

/** Runs a service and sends its { status, ... } result. Errors go to the error handler. */
export const handle =
  (fn: (req: Request) => Promise<{ status: number } & Record<string, unknown>>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req);
      res.status(result.status).json(result);
    } catch (error) {
      next(error);
    }
  };

export const me = (req: Request) => req.user as any;
