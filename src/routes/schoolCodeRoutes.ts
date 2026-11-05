import express from 'express';
import { adminLoginRequired, optionalLogin } from '../middlewares/auth';
import {
  createSchoolCode,
  listSchoolCodes,
  redeemSchoolCode,
  setSchoolCodeActive,
} from '../controllers/schoolCodeController';

const router = express.Router();

// Students: use a code from their school (logged in, or a visitor from the eligibility form).
router.post('/redeem', optionalLogin, redeemSchoolCode);

// Admins: create, list and switch codes on or off.
router.get('/', adminLoginRequired, listSchoolCodes);
router.post('/', adminLoginRequired, createSchoolCode);
router.patch('/:id', adminLoginRequired, setSchoolCodeActive);

export default router;
