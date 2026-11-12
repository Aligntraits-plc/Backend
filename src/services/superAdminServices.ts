// import { sendAdminSetupEmail } from './mailService'; // Import your email service
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import {
  createUser,
  deleteUser,
  getUserByEmail,
  getUserById,
  updateUser,
  // getUsersByRoles,
} from '../models/userModel';

import {
  sendAdminCreateEmail,
  sendAdminUpdateEmail,
  sendAdminDeleteEmail,
} from './mailServices';
import { db } from '../config/db';
import { INVITABLE_STAFF, PANEL_STAFF } from './roles';

dotenv.config();

const isPanelRole = (role: string) => (PANEL_STAFF as readonly string[]).includes(role);
const superAdminCount = () => db.user.count({ where: { role: 'SUPER_ADMIN' } });

// Validation schema for admin profile (unchanged from your latest request)
const adminProfileSchema = z.object({
  firstname: z
    .string()
    .min(1, 'First Name is required')
    .regex(/^[a-zA-Z\s]+$/, 'First Name must contain only letters'),
  lastname: z
    .string()
    .min(1, 'Last Name is required')
    .regex(/^[a-zA-Z\s]+$/, 'Last Name must contain only letters'),
  email: z.string().email('Please enter a valid email address'),
  contactNumber: z
    .string()
    .regex(/^\d+$/, 'Contact Number must be numeric')
    .min(10, 'Contact Number must be at least 10 digits')
    .max(15, 'Contact Number must not exceed 15 digits'),
  role: z.enum(['ADMIN', 'SUPER_ADMIN', 'ANALYST', 'CONTENT_MANAGER'], {
    message: 'Role must be either ADMIN or SUPER_ADMIN',
  }),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// New Services for Admin Profile Management (without ActionHistory)
export const createAdminProfileService = async (
  superAdminId: string,
  data: any
) => {
  try {
    // Staff accounts are created by invitation now (POST /staff/invites): the new
    // person sets their own password from an emailed link, so no password is ever
    // chosen by someone else or sent by email.
    if (process.env.ALLOW_DIRECT_STAFF_CREATE !== 'on') {
      return {
        status: 410,
        message: 'Staff accounts are now created by invitation. Open Team and send an invitation.',
        errors: [{ message: 'Staff accounts are now created by invitation.' }],
      };
    }
    // Check super admin permissions
    const superAdmin = await getUserById(superAdminId);
    if (!superAdmin || superAdmin.role !== 'SUPER_ADMIN') {
      return {
        status: 403,
        message: 'Unauthorized: Only super admins can create admin profiles',
      };
    }

    const parsedData = adminProfileSchema.parse(data);

    // Check if email already exists
    const existingUser = await getUserByEmail(parsedData.email);
    if (existingUser) {
      return {
        status: 400,
        message: 'Email already in use',
        errors: [{ message: 'Email already exists' }],
      };
    }

    // Hash the provided password
    const hashedPassword = await bcrypt.hash(parsedData.password, 10);

    const newAdmin = await createUser({
      data: {
        firstname: parsedData.firstname,
        lastname: parsedData.lastname,
        email: parsedData.email,
        contactNumber: parsedData.contactNumber,
        role: parsedData.role,
        password: hashedPassword,
      },
    });

    // Send admin creation email with the password (no OTP)
    await sendAdminCreateEmail({
      name: `${newAdmin.firstname} ${newAdmin.lastname}`,
      email: newAdmin.email,
      password: parsedData.password, // Using password as OTP for now, adjust if needed
    });

    return {
      status: 201,
      message:
        'Admin profile created successfully. A setup email has been sent.',
      data: {
        id: newAdmin.id,
        firstname: newAdmin.firstname,
        lastname: newAdmin.lastname,
        email: newAdmin.email,
        contactNumber: newAdmin.contactNumber,
        role: newAdmin.role,
      },
    };
  } catch (e) {
    if (e instanceof z.ZodError) {
      return {
        status: 400,
        message: 'Validation failed',
        errors: e.errors.map((err) => ({ message: err.message })),
      };
    }
    throw e;
  }
};

// Schema without role
const adminProfileUpdateSchema = z.object({
  firstname: z
    .string()
    .min(1, 'First Name is required')
    .regex(/^[a-zA-Z\s]+$/, 'First Name must contain only letters')
    .optional(),
  lastname: z
    .string()
    .min(1, 'Last Name is required')
    .regex(/^[a-zA-Z\s]+$/, 'Last Name must contain only letters')
    .optional(),
  email: z.string().email('Please enter a valid email address').optional(),
  contactNumber: z
    .string()
    .regex(/^\d+$/, 'Contact Number must be numeric')
    .min(10, 'Contact Number must be at least 10 digits')
    .max(15, 'Contact Number must not exceed 15 digits')
    .optional(),
  role: z.enum(INVITABLE_STAFF, { message: 'Pick Super admin, Admin or Content manager' }).optional(),
});

export const updateAdminProfileService = async (
  superAdminId: string, // From middleware (req.user.id)
  adminId: string, // From route params (req.params.id)
  data: any // From request body (req.body)
) => {
  try {
    // Check super admin permissions using middleware role
    const superAdmin = await getUserById(superAdminId);
    if (!superAdmin || superAdmin.role !== 'SUPER_ADMIN') {
      return {
        status: 403,
        message: 'Unauthorized: Only super admins can update admin profiles',
      };
    }

    // Parse request data
    const parsedData = adminProfileUpdateSchema.parse(data);

    // Fetch the admin to update
    const adminToUpdate = await getUserById(adminId);
    if (!adminToUpdate || !isPanelRole(adminToUpdate.role)) {
      return { status: 404, message: 'Admin profile not found' };
    }
    if (parsedData.role && parsedData.role !== adminToUpdate.role) {
      if (adminToUpdate.id === superAdminId) {
        return { status: 400, message: 'You cannot change your own role. Ask another super admin.' };
      }
      if (adminToUpdate.role === 'SUPER_ADMIN' && (await superAdminCount()) <= 1) {
        return { status: 400, message: 'This is the only super admin. Make someone else a super admin first.' };
      }
    }

    // Build update data dynamically
    const updateData: any = {};
    if (parsedData.firstname) updateData.firstname = parsedData.firstname;
    if (parsedData.lastname) updateData.lastname = parsedData.lastname;
    if (parsedData.email) updateData.email = parsedData.email;
    if (parsedData.contactNumber)
      updateData.contactNumber = parsedData.contactNumber;
    if (parsedData.role) updateData.role = parsedData.role;
    // Passwords are never set here: each person sets their own.

    const updatedAdmin = await updateUser(adminId, updateData);

    if (!updatedAdmin) {
      return {
        status: 500,
        message: 'Failed to update admin profile',
        errors: [{ message: 'Server error during update' }],
      };
    }

    // Send update notification email
    await sendAdminUpdateEmail({
      name: `${updatedAdmin.firstname} ${updatedAdmin.lastname}`,
      email: updatedAdmin.email,
    });

    return {
      status: 200,
      message: 'Admin profile updated successfully',
      data: {
        id: updatedAdmin.id,
        firstname: updatedAdmin.firstname,
        lastname: updatedAdmin.lastname,
        email: updatedAdmin.email,
        contactNumber: updatedAdmin.contactNumber,
        role: updatedAdmin.role, // Return existing role
      },
    };
  } catch (e) {
    if (e instanceof z.ZodError) {
      return {
        status: 400,
        message: 'Validation failed',
        errors: e.errors.map((err) => ({ message: err.message })),
      };
    }
    throw e;
  }
};

// delete
export const deleteAdminProfileService = async (
  superAdminId: string,
  adminId: string
) => {
  try {
    // Check super admin permissions
    const superAdmin = await getUserById(superAdminId);
    if (!superAdmin || superAdmin.role !== 'SUPER_ADMIN') {
      return {
        status: 403,
        message: 'Unauthorized: Only super admins can delete admin profiles',
      };
    }

    const adminToDelete = await getUserById(adminId);
    if (!adminToDelete || !isPanelRole(adminToDelete.role)) {
      return { status: 404, message: 'Admin profile not found' };
    }
    if (adminToDelete.id === superAdminId) {
      return { status: 400, message: 'You cannot remove your own account. Ask another super admin.' };
    }
    if (adminToDelete.role === 'SUPER_ADMIN' && (await superAdminCount()) <= 1) {
      return { status: 400, message: 'This is the only super admin, so it cannot be removed.' };
    }

    await deleteUser(adminId);

    // Send delete notification email
    await sendAdminDeleteEmail({
      name: `${adminToDelete.firstname} ${adminToDelete.lastname}`,
      email: adminToDelete.email,
    });

    return {
      status: 200,
      message: 'Admin profile deleted successfully',
    };
  } catch (e) {
    throw e;
  }
};

export const getAdminByIdService = async (id: string) => {
  const user = await getUserById(id);

  if (!user || user.role === 'USER') {
    return { status: 404, message: 'Admin not found or access denied' };
  }

  return {
    status: 200,
    message: 'Admin found',
    data: {
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      contactNumber: user.contactNumber,
      role: user.role,
    },
  };
};

export const listAdminsService = async () => {
  const roles = ['ADMIN', 'SUPER_ADMIN', 'ANALYST', 'CONTENT_MANAGER'];

  const users = await db.user.findMany({
    where: {
      role: {
        in: roles as any, // use 'as any' to bypass Prisma enum type check
      },
    },
  });

  return {
    status: 200,
    message: 'Admin list retrieved',
    data: users.map((user) => ({
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      contactNumber: user.contactNumber,
      role: user.role,
    })),
  };
};

// get users and wait list by admin
export const getUsersByAdminService = async () => {
  const excludedRoles = ['ADMIN', 'SUPER_ADMIN', 'ANALYST', 'CONTENT_MANAGER'];

  const users = await db.user.findMany({
    where: {
      role: {
        notIn: excludedRoles as any, // Exclude the specified admin roles
      },
    },
  });

  return {
    status: 200,
    message: 'User list retrieved (excluding admin roles)',
    data: users.map((user) => ({
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      gender: user.gender,
      region: user.region,
    })),
  };
};

// get waitlist users by admin
export const getWaitListByAdminService = async () => {
  const waitList = await db.waitList.findMany(); // Fetch all waitlist entries

  return {
    status: 200,
    message: 'Waitlist retrieved successfully',
    data: waitList.map((entry) => ({
      id: entry.id,
      email: entry.email,
      createdAt: entry.createdAt,
    })),
  };
};

export const getUserDetailsByAdminService = async () => {
  const users = await db.user.findMany({
    // Fetch all users with detailed fields
  });

  return {
    status: 200,
    message: 'User details retrieved successfully',
    data: users.map((user) => ({
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      contactNumber: user.contactNumber,
      image: user.image,
      updatedAt: user.updatedAt,
      createdAt: user.createdAt,
      region: user.region,
      bio: user.bio,
      // Add more fields as needed based on your User model (e.g., payment_plan, createdAt, etc.)
    })),
  };
};
