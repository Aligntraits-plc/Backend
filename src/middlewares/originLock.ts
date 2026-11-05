import cors from 'cors';
import { NextFunction, Request, Response } from 'express';

/*
  Only the AlignTraits website may call this API from a browser.

  - Browsers send an Origin header with every call a web page makes to this API.
    Calls from aligntraits.com (and www) are allowed. Calls from any other website
    get 403, so another site can't use the API from its pages.
  - Requests without an Origin header are not browser calls from another site:
    Paystack webhooks, the Google sign-in redirect, Railway health checks and
    email links. Those still work, and each route keeps its own login checks.

  Add more allowed sites (a staging site, or localhost while developing) with
  ALLOWED_ORIGINS, comma separated, for example:
  ALLOWED_ORIGINS=https://staging.aligntraits.com,http://localhost:5173
*/
const DEFAULT_ORIGINS = ['https://aligntraits.com', 'https://www.aligntraits.com'];

const clean = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();

export function allowedOrigins(): Set<string> {
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(clean).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

export function originLock() {
  const allowed = allowedOrigins();
  const isAllowed = (origin: string | undefined) => !origin || allowed.has(clean(origin));

  const block = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (isAllowed(origin)) return next();
    return res.status(403).json({
      ok: false,
      status: 403,
      message: 'This API only accepts requests from aligntraits.com.',
      errors: [{ message: 'This API only accepts requests from aligntraits.com.' }],
    });
  };

  const corsForSite = cors({
    origin: (origin, done) => done(null, isAllowed(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  return [block, corsForSite];
}
