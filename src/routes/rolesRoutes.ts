import express from 'express';
import {
  adminLoginRequired,
  counsellorLoginRequired,
  loginRequired,
} from '../middlewares/auth';
import { getStudentSettingsService, saveStudentAcademicsService, saveStudentProfileService } from '../services/studentSettingsService';
import { handle, me } from './handle';
import {
  acceptInviteService,
  createInviteService,
  listInvitesService,
  readInviteService,
  resendInviteService,
  revokeInviteService,
} from '../services/inviteService';
import {
  acknowledgeSchoolNoticeService,
  adminCreateSchoolService,
  adminListSchoolsService,
  adminUpdateSchoolService,
  leaveMySchoolService,
  listSchoolsForPickerService,
  mySchoolService,
  portalAssistedStudentService,
  portalCheckoutService,
  portalCodesService,
  portalCoverStudentService,
  portalInviteStudentsService,
  portalInvitesService,
  portalOverviewService,
  portalRemoveStudentService,
  portalReviewService,
  portalStudentService,
  portalStudentsService,
  portalUpdateStudentService,
  portalVerifyPaymentService,
  requestSchoolListingService,
  setMySchoolService,
} from '../services/partnerSchoolService';
import {
  adminListAmbassadorsService,
  adminMakeAmbassadorService,
  adminSetAmbassadorActiveService,
  ambassadorInviteService,
  claimReferralService,
  createEventDraftService,
  deleteEventDraftService,
  myAmbassadorService,
  myEventDraftsService,
  updateEventDraftService,
} from '../services/ambassadorService';
import {
  listRequestsService,
  markRequestsSeenService,
  requestsSummaryService,
  setRequestStatusService,
} from '../services/requestsService';
import {
  parentLinkService,
  publicParentReportService,
  removeApplicationService,
  removeShortlistService,
  saveApplicationService,
  saveShortlistService,
  studentHomeService,
} from '../services/studentHomeService';

/*
  Roles v1 routes, all under /api/v1:

  Invitations (staff, counsellors, ambassadors)
    POST   /staff/invites                 admins (only super admins can invite staff)
    GET    /staff/invites
    POST   /staff/invites/:id/resend
    DELETE /staff/invites/:id
    GET    /invites/:token                public: the invited person
    POST   /invites/:token/accept         public: set name and password

  Partner schools (admins)
    GET|POST /partner-schools/admin, PATCH /partner-schools/admin/:id
  Students and their school
    GET  /partner-schools/options?q=      signed in: the picker
    GET|PUT|DELETE /me/school, POST /me/school/notice-seen, POST /me/school/not-listed
  School portal (counsellors only, their own school only)
    /school-portal/...
  Ambassadors
    GET /ambassadors/me, POST /ambassadors/me/invites, POST /ambassadors/referral
    GET|POST /ambassadors/me/events, PATCH|DELETE /ambassadors/me/events/:id
    GET|POST /ambassadors/admin, PATCH /ambassadors/admin/:id   admins
  Requests (admins)
    GET /requests?kind=, GET /requests/summary, POST /requests/seen, PATCH /requests/:kind/:id
  Student dashboard
    GET /student/home, POST|DELETE /student/shortlist, POST|PATCH|DELETE /student/applications
    GET /student/parent-link, GET /reports/parent/:token (public)
*/
const router = express.Router();

/* Invitations */
router.post('/staff/invites', adminLoginRequired, handle((req) => createInviteService(me(req), req.body || {})));
router.get('/staff/invites', adminLoginRequired, handle((req) => listInvitesService(me(req))));
router.post('/staff/invites/:id/resend', adminLoginRequired, handle((req) => resendInviteService(me(req), req.params.id)));
router.delete('/staff/invites/:id', adminLoginRequired, handle((req) => revokeInviteService(me(req), req.params.id)));
router.get('/invites/:token', handle((req) => readInviteService(req.params.token)));
router.post('/invites/:token/accept', handle((req) => acceptInviteService(req.params.token, req.body || {})));

/* Partner schools: admin */
router.get('/partner-schools/admin', adminLoginRequired, handle(() => adminListSchoolsService()));
router.post('/partner-schools/admin', adminLoginRequired, handle((req) => adminCreateSchoolService(me(req), req.body || {})));
router.patch('/partner-schools/admin/:id', adminLoginRequired, handle((req) => adminUpdateSchoolService(req.params.id, req.body || {})));

/* Students: my school */
router.get('/partner-schools/options', loginRequired, handle((req) => listSchoolsForPickerService(req.query.q)));
router.get('/me/school', loginRequired, handle((req) => mySchoolService(me(req))));
router.put('/me/school', loginRequired, handle((req) => setMySchoolService(me(req), req.body || {})));
router.delete('/me/school', loginRequired, handle((req) => leaveMySchoolService(me(req))));
router.post('/me/school/notice-seen', loginRequired, handle((req) => acknowledgeSchoolNoticeService(me(req))));
router.post('/me/school/not-listed', loginRequired, handle((req) => requestSchoolListingService(me(req), req.body || {})));

/* School portal */
const portal = express.Router();
portal.use(counsellorLoginRequired);
portal.get('/overview', handle((req) => portalOverviewService(me(req))));
portal.get('/students', handle((req) => portalStudentsService(me(req), req.query.q)));
portal.get('/students/:id', handle((req) => portalStudentService(me(req), req.params.id)));
portal.patch('/students/:id', handle((req) => portalUpdateStudentService(me(req), req.params.id, req.body || {})));
portal.delete('/students/:id', handle((req) => portalRemoveStudentService(me(req), req.params.id)));
portal.post('/students/:id/cover', handle((req) => portalCoverStudentService(me(req), req.params.id)));
portal.put('/students/:id/review', handle((req) => portalReviewService(me(req), req.params.id, req.body?.approved)));
portal.get('/invites', handle((req) => portalInvitesService(me(req))));
portal.post('/invites', handle((req) => portalInviteStudentsService(me(req), req.body?.emails)));
portal.post('/assisted', handle((req) => portalAssistedStudentService(me(req), req.body || {})));
portal.get('/codes', handle((req) => portalCodesService(me(req))));
portal.post('/checkout', handle((req) => portalCheckoutService(me(req), req.body?.seats)));
portal.post('/verify-payment', handle((req) => portalVerifyPaymentService(me(req), req.body?.reference)));
router.use('/school-portal', portal);

/* Ambassadors */
router.get('/ambassadors/me', loginRequired, handle((req) => myAmbassadorService(me(req))));
router.post('/ambassadors/me/invites', loginRequired, handle((req) => ambassadorInviteService(me(req), req.body?.email)));
router.post('/ambassadors/referral', loginRequired, handle((req) => claimReferralService(me(req), req.body?.code)));
router.get('/ambassadors/me/events', loginRequired, handle((req) => myEventDraftsService(me(req))));
router.post('/ambassadors/me/events', loginRequired, handle((req) => createEventDraftService(me(req), req.body || {})));
router.patch('/ambassadors/me/events/:id', loginRequired, handle((req) => updateEventDraftService(me(req), req.params.id, req.body || {})));
router.delete('/ambassadors/me/events/:id', loginRequired, handle((req) => deleteEventDraftService(me(req), req.params.id)));
router.get('/ambassadors/admin', adminLoginRequired, handle(() => adminListAmbassadorsService()));
router.post('/ambassadors/admin', adminLoginRequired, handle((req) => adminMakeAmbassadorService(me(req), req.body?.email)));
router.patch('/ambassadors/admin/:id', adminLoginRequired, handle((req) => adminSetAmbassadorActiveService(req.params.id, req.body?.active)));

/* Requests */
router.get('/requests/summary', adminLoginRequired, handle((req) => requestsSummaryService(me(req))));
router.post('/requests/seen', adminLoginRequired, handle((req) => markRequestsSeenService(me(req))));
router.get('/requests', adminLoginRequired, handle((req) => listRequestsService(me(req), req.query.kind)));
router.patch('/requests/:kind/:id', adminLoginRequired, handle((req) => setRequestStatusService(req.params.kind, req.params.id, req.body?.status)));

/* Student dashboard */
router.get('/student/home', loginRequired, handle((req) => studentHomeService(me(req))));
router.post('/student/shortlist', loginRequired, handle((req) => saveShortlistService(me(req), req.body || {})));
router.delete('/student/shortlist/:courseId', loginRequired, handle((req) => removeShortlistService(me(req), req.params.courseId)));
router.post('/student/applications', loginRequired, handle((req) => saveApplicationService(me(req), req.body || {})));
router.patch('/student/applications', loginRequired, handle((req) => saveApplicationService(me(req), req.body || {})));
router.delete('/student/applications/:id', loginRequired, handle((req) => removeApplicationService(me(req), req.params.id)));
router.get('/student/parent-link', loginRequired, handle((req) => parentLinkService(me(req))));

/* ---------- Student: Profile and settings ---------- */
router.get('/student/settings', loginRequired, handle((req) => getStudentSettingsService(me(req))));
router.put('/student/settings/profile', loginRequired, handle((req) => saveStudentProfileService(me(req), req.body || {})));
router.put('/student/settings/academics', loginRequired, handle((req) => saveStudentAcademicsService(me(req), req.body || {})));
router.get('/reports/parent/:token', handle((req) => publicParentReportService(req.params.token)));

export default router;
