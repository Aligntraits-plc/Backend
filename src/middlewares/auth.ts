// src/middlewares/auth.ts
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { NextFunction, Request, Response } from 'express';
import { getUserById } from '../models/userModel';
import { ADMINS, CONTENT_TEAM, PANEL_STAFF, STAFF_LOGIN, SUPER_ADMINS } from '../services/roles';

dotenv.config();

/*
  One check for every protected route: a valid login and, when `roles` is given,
  one of those roles. The role is read from the database on every request, so a
  role change or a removed account takes effect straight away.
  Role lists live in src/services/roles.ts.
*/
const requireRoles =
  (roles: readonly string[] | null, denied = 'Access denied, not an admin') =>
  async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send('Access denied, empty token');

    const token = authHeader.split(' ')[1] ?? '';
    try {
      const verified = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
      const user = await getUserById(verified.userId);
      if (!user) return res.status(404).send('User not found');
      if (roles && !roles.includes(user.role)) return res.status(403).send(denied);
      req.user = user; // Set full Prisma User object
      next();
    } catch (err) {
      return res.status(400).send('Invalid token');
    }
  };

/** Any signed-in account. */
export const loginRequired = requireRoles(null);
/** Admins and super admins. */
export const adminLoginRequired = requireRoles(ADMINS);
/** Admins, super admins and content managers: schools, courses and requirements. */
export const adminContCrtorLoginRequired = requireRoles(CONTENT_TEAM);
/** Anyone with an admin panel account. Used for read only tools such as the export. */
export const staffLoginRequired = requireRoles(PANEL_STAFF);
/** Admin panel accounts and school counsellors: their own profile and password. */
export const staffOrCounsellorLoginRequired = requireRoles(STAFF_LOGIN);
/** Super admins only. */
export const superAdminLoginRequired = requireRoles(SUPER_ADMINS, 'Access denied, not a Super Admin');
/** School counsellors only (the school portal). */
export const counsellorLoginRequired = requireRoles(['COUNSELLOR'], 'Access denied, not a school account');

export const preventLoggedUser = (req: Request, res: Response, next: NextFunction) => {
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

// Uses the login when there is a valid one, and carries on as a visitor when
// there is none (or it has expired). For routes that serve both.
export const optionalLogin = async (req: Request, _res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
    const user = await getUserById(verified.userId);
    if (user) req.user = user;
  } catch {
    // Not a usable login: treat as a visitor.
  }
  next();
};
