import express from 'express';
import {
  adminContCrtorLoginRequired,
  adminLoginRequired,
} from '../middlewares/auth';
import {
  createCourseController,
  createSchoolController,
  getAllSchoolsController,
  getSchoolByIdController,
  updateCourseController,
  deleteSchoolsController,
  searchSchoolsController,
  deleteCourseController,
  updateSchoolController,
  getCourseByIdController,
  getAllCoursesController,
  getAllHistoryController,
  getAdminDashboard,
} from '../controllers/schoolController';
import multer from 'multer';
import MessageResponse from '../types/messageResponse';

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

// school
router.post<{}, MessageResponse>(
  '/add-school',
  adminLoginRequired,
  upload.single('logo'),
  createSchoolController
);

// course
router.post<{}, MessageResponse>(
  '/add-course',
  adminLoginRequired,
  upload.single('image'),
  createCourseController
);

// school
router.get('/get/all', getAllSchoolsController);
router.get('/get/:id', getSchoolByIdController);

// get a single course by ID
router.get('/course/:id', getCourseByIdController); // Add this route

// get all courses
router.get('/courses', getAllCoursesController); // Add this route

// update course
router.patch(
  '/course/:id',
  adminContCrtorLoginRequired,
  upload.single('image'),
  updateCourseController
);

// delete course
router.delete('/course/delete/:id', adminLoginRequired, deleteCourseController);

// update school
router.patch(
  '/update/:id',
  adminContCrtorLoginRequired,
  upload.single('logo'),
  updateSchoolController
);

// delete school and associated courses
router.delete('/delete/:schoolId', adminLoginRequired, deleteSchoolsController);

// search schools by location
// router.get('/search/location/:location', searchSchoolsController);
router.get('/search/location', searchSchoolsController);

// Content managers run uploads too, so they see the upload history.
router.get('/get/all/history', adminContCrtorLoginRequired, getAllHistoryController);

// New route for Admin Dashboard
// curl "http://localhost:3000/api/v1/admin/dashboard?startDate=2024-01-01&endDate=2024-12-31&location=Lagos" \
// -H "Authorization: Bearer <admin-token>"
router.get<{}, MessageResponse>(
  '/admin/dashboard',
  adminLoginRequired,
  getAdminDashboard
);

export default router;
