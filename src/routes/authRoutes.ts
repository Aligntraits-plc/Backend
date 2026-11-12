import express from 'express';
import {
  adminContCrtorLoginRequired,
  adminLoginRequired,
  staffOrCounsellorLoginRequired,
  preventLoggedUser,
  superAdminLoginRequired,
} from '../middlewares/auth';
import authController from '../controllers/authController';
import MessageResponse from '../types/messageResponse';
import { NextFunction, Request, Response } from 'express';
import passport from 'passport'; // Add Passport import for Google OAuth

const router = express.Router();

// Existing routes (unchanged)
router.post<{}, MessageResponse>(
  '/register',
  preventLoggedUser,
  authController.register
);

router.post<{}, MessageResponse>(
  '/login',
  preventLoggedUser,
  authController.login
);

router.post<{}, MessageResponse>(
  '/request-reset',
  preventLoggedUser,
  authController.requestReset
);

// Visitors who did the quiz, a check or a payment before they had a password.
// Step 1: email them a link that proves they own the inbox.
router.post<{}, MessageResponse>(
  '/send-setup-link',
  preventLoggedUser,
  authController.sendSetupLink
);

// Step 2: the link's code plus the new password. Refused without a valid code,
// and refused for any account that already has a password.
router.post<{}, MessageResponse>(
  '/add-password-after-eligibility',
  preventLoggedUser,
  authController.addPasswordAfterEligibilty
);

router.get<{}, MessageResponse>(
  '/verification',
  preventLoggedUser,
  authController.validateToken
);

router.put<{}, MessageResponse>(
  '/reset-password',
  preventLoggedUser,
  authController.resetPassword
);

// Admin login route section
router.post<{}, MessageResponse>(
  '/admin/login',
  preventLoggedUser,
  authController.loginAdmin
);

// Super admins only. Super admins can also create admins from
// /super-admin/admin/profiles, which emails the new admin their details.
router.post<{}, MessageResponse>(
  '/admin/register',
  superAdminLoginRequired,
  authController.registerAdmin
);

router.get<{}, MessageResponse>(
  '/admin/details',
  staffOrCounsellorLoginRequired,
  authController.getAdmindetails
);

// Super admins only, and only for admin panel accounts (never students).
router.patch<{}, MessageResponse>(
  '/admin/add-password',
  superAdminLoginRequired,
  authController.AddAdminPassword
);

// New routes for profile and password management
router.patch<{}, MessageResponse>(
  '/admin/profile',
  staffOrCounsellorLoginRequired,
  authController.updateAdminProfile
);

router.patch<{}, MessageResponse>(
  '/admin/password',
  staffOrCounsellorLoginRequired,
  authController.updateAdminPassword
);

export default router;
