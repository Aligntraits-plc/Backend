import { NextFunction, Request, Response } from 'express';
import {
  createSchoolCodeService,
  listSchoolCodesService,
  redeemSchoolCodeService,
  setSchoolCodeActiveService,
} from '../services/schoolCodeService';

export const createSchoolCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await createSchoolCodeService({
      schoolName: req.body?.schoolName,
      seats: req.body?.seats,
      adminId: (req.user as any)?.id ?? '',
    });
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const listSchoolCodes = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listSchoolCodesService();
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const setSchoolCodeActive = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setSchoolCodeActiveService(req.params.id, req.body?.active);
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

// Logged in students use their own account. Visitors (who came through the
// eligibility form) send the email, first name and last name they entered there.
export const redeemSchoolCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await redeemSchoolCodeService({
      code: req.body?.code,
      user: (req.user as any) ?? null,
      visitor: {
        email: req.body?.email,
        firstname: req.body?.firstname,
        lastname: req.body?.lastname,
      },
    });
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};
