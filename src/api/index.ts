import express from 'express';

import MessageResponse from '../types/messageResponse';
import UserRoutes from '../routes/userRoutes';
import AuthRoutes from '../routes/authRoutes';
import surveyRoutes from '../routes/surveryRoutes';
import schoolRoutes from '../routes/schoolRoutes';
import bulkRoutes from '../routes/bulk-test-route';
import superAdminRoutes from '../routes/superAdminRoute';
import WaitlistRoutes from '../routes/waitistRoutes';
import GoogleRoutes from '../routes/googleRoute';
import DashboardRoutes from '../routes/dashboardRoutes';
import SkillRoutes from '../routes/skillRoutes';
import AdmissionLogicRoutes from '../routes/admissionLogicRoute';
import AdminResetRoutes from '../routes/admin/adminPasswordResetRoutes';
import CareerRoutes from '../routes/careerPathRoutes';
import WetrocloudEligibilityRoutes from '../routes/eligibiltyRoutes';
import ServerEligibilityRoutes from '../routes/eligibility/serverEligibilityRoute';
import CourseCategoriesRoutes from '../routes/courseCategoriesRoutes';
import PaymentRoutes from '../routes/paymentRoutes';
import FeedbackRoutes from '../routes/feedbackRoutes';
// for testing monthly payment
import MonthlyPaymentRoutes from '../routes/monthlyPaymentRoutes';
import BulkImageuploadRoutes from '../routes/bulkImageuploadRoute';
import FormsRoutes from '../routes/formsRoutes';
import SchoolCodeRoutes from '../routes/schoolCodeRoutes';

const router = express.Router();

router.get<{}, MessageResponse>('/', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'AlignTraits API v1 - 👋🌎🌍🌏',
  });
});

router.use('/users', UserRoutes);
router.use('/auth', AuthRoutes);
router.use('/school', schoolRoutes);
router.use('/bulk', bulkRoutes);
router.use('/super-admin', superAdminRoutes);
router.use('/survey', surveyRoutes);
router.use('/waitlist', WaitlistRoutes);
router.use('/google-auth', GoogleRoutes);
router.use('/dashboard', DashboardRoutes);
router.use('/skill', SkillRoutes);
router.use('/admission-logic', AdmissionLogicRoutes);
router.use('/admin-reset', AdminResetRoutes);
router.use('/career', CareerRoutes);
router.use('/server/eligible', ServerEligibilityRoutes);
router.use('/wetrocloud/eligible', WetrocloudEligibilityRoutes);
router.use('/categories/course', CourseCategoriesRoutes);
router.use('/payment', PaymentRoutes);
router.use('/feedback', FeedbackRoutes);
// for testing monthly payment
router.use('/monthly/payment', MonthlyPaymentRoutes);
router.use('/images', BulkImageuploadRoutes);
// Website forms: ambassador applications and pilot requests
router.use('/forms', FormsRoutes);
router.use('/school-codes', SchoolCodeRoutes);

export default router;
