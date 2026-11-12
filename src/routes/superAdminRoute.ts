import express from 'express';
import {
  adminLoginRequired,
  preventLoggedUser,
  adminContCrtorLoginRequired,
  superAdminLoginRequired,
} from '../middlewares/auth';
import superAdminController from '../controllers/superAdminCtl';
import MessageResponse from '../types/messageResponse';
import { NextFunction, Request, Response } from 'express';
import { use } from 'passport';

const router = express.Router();

// New routes for Admin Profile Management CRUD
router.post<{}, MessageResponse>(
  '/admin/profiles',
  superAdminLoginRequired,
  superAdminController.createAdminProfile
);
router.patch<{ id: string }, MessageResponse>(
  '/admin/profiles/:id',
  superAdminLoginRequired,
  superAdminController.updateAdminProfile
);
router.delete<{ id: string }, MessageResponse>(
  '/admin/profiles/:id',
  superAdminLoginRequired,
  superAdminController.deleteAdminProfile
);

router.get<{ id: string }, MessageResponse>(
  '/admin/profiles/:id',
  superAdminLoginRequired,
  superAdminController.getAdminById
);

router.get<{}, MessageResponse>(
  '/admin/profiles',
  superAdminLoginRequired,
  superAdminController.listAdmins
);

// get users and wait list by admin
router.get<{}, MessageResponse>(
  '/admin/user-list-by-admin',
  adminLoginRequired,
  superAdminController.getUsersByAdmin // Renamed from listAdmins
);

// get waitlist users by admin
router.get<{}, MessageResponse>(
  '/admin/waitlist',
  adminLoginRequired, // New endpoint for waitlist
  superAdminController.getWaitListByAdmin // New controller method
);

router.get<{}, MessageResponse>(
  '/admin/user-details',
  adminLoginRequired, // New endpoint for user details
  superAdminController.getUserDetailsByAdmin // New controller method
);

export default router;
