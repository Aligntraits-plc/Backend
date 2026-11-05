// src/middlewares/auth.ts
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { NextFunction, Request, Response } from 'express';
import { getUserById } from '../models/userModel';

dotenv.config();

export const loginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Access denied, empty token');

  const token = authHeader.split(' ')[1] ?? '';
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (!user) return res.status(404).send('User not found');
    req.user = user; // Set full Prisma User object
    next();
  } catch (err) {
    console.log(err);
    return res.status(400).send('Invalid token');
  }
};

export const preventLoggedUser = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next(); // No token, proceed

  const token = authHeader.split(' ')[1] ?? '';
  try {
    jwt.verify(token, process.env.JWT_SECRET as string);
    return res.status(401).send('Access denied, already logged in');
  } catch (err) {
    return next(); // Invalid token, proceed as if not logged in
  }
};

export const adminLoginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Access denied, empty token');

  const token = authHeader.split(' ')[1] ?? '';
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (!user) return res.status(404).send('User not found');
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      // Allow both roles
      return res.status(403).send('Access denied, not an admin');
    }
    req.user = user; // Set full Prisma User object
    next();
  } catch (err) {
    console.log(err);
    return res.status(400).send('Invalid token');
  }
};

export const adminContCrtorLoginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Access denied, empty token');

  const token = authHeader.split(' ')[1] ?? '';
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (!user) return res.status(404).send('User not found');
    if (
      user.role !== 'ADMIN' &&
      user.role !== 'SUPER_ADMIN' &&
      user.role !== 'CONTENT_MANAGER'
    ) {
      // Allow both roles
      return res.status(403).send('Access denied, not an admin');
    }
    req.user = user; // Set full Prisma User object
    next();
  } catch (err) {
    console.log(err);
    return res.status(400).send('Invalid token');
  }
};

// Uses the login when there is a valid one, and carries on as a visitor when
// there is none (or it has expired). For routes that serve both.
export const optionalLogin = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (user) req.user = user;
  } catch {
    // Not a usable login: treat as a visitor.
  }
  next();
};

// Any admin panel account, including analysts. Used for read only staff tools
// such as the school and course export.
export const staffLoginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Access denied, empty token');

  const token = authHeader.split(' ')[1] ?? '';
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (!user) return res.status(404).send('User not found');
    if (
      user.role !== 'ADMIN' &&
      user.role !== 'SUPER_ADMIN' &&
      user.role !== 'CONTENT_MANAGER' &&
      user.role !== 'ANALYST'
    ) {
      return res.status(403).send('Access denied, not an admin');
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(400).send('Invalid token');
  }
};

export const superAdminLoginRequired = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.log('🚨 No auth header found');
    return res.status(401).send('Access denied, empty token');
  }

  const token = authHeader.split(' ')[1] ?? '';
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: string;
    };
    const user = await getUserById(verified.userId);
    if (!user) {
      console.log('🚨 User not found');
      return res.status(404).send('User not found');
    }
    if (user.role !== 'SUPER_ADMIN') {
      console.log('🚨 Access denied: User is not a Super Admin');
      return res.status(403).send('Access denied, not a Super Admin');
    }
    req.user = user; // Set full Prisma User object
    console.log('✅ Access granted: User is a Super Admin');
    next();
  } catch (err) {
    console.log('🚨 JWT Error:', err);
    return res.status(400).send('Invalid token');
  }
};
