import sharp from 'sharp';
import cloudinary from '../config/cloudinary';
import bcrypt from 'bcryptjs';
import {
  User,
  EligibilityResult,
  CareerResult,
  Transaction,
  UserCard,
  UserDirectDebit,
  ActionHistory,
  ResultDocument,
  UserResponse,
  Interest,
  Skill,
  Roles, // <-- Add this line
  Gender, // <-- Add this line if Gender is also missing
  PaymentPlan, // <-- Add this line if PaymentPlan is also missing
} from '@prisma/client';
import { getUserById, updateUser, getUserByEmail } from '../models/userModel';
import { parseDate } from '../lib/utils';
import { db } from '../config/db';
import { getSchoolAccessForUser } from './schoolCodeService';
import MessageResponse from '../types/messageResponse';

// Extend the User type with relations
type UserWithRelations = User & {
  eligibilityResults: EligibilityResult[];
  careerResults: CareerResult | null;
  transactions: Transaction[];
  userCards: UserCard[];
  userDirectDebits: UserDirectDebit[];
  actionHistories: ActionHistory[];
  ResultDocument: ResultDocument[];
  UserResponse: UserResponse[];
  interests: (Interest & { interest: Interest })[]; // Adjust based on actual relation
  skills: (Skill & { skill: Skill })[]; // Adjust based on actual relation
};

export const getAdminDataService = async (userId: string) => {
  try {
    const user = await getUserById(userId);
    if (!user)
      return {
        ok: false,
        status: 404,
        message: 'User not found',
        errors: [{ message: 'User does not exist' }],
      };

    return {
      ok: true,
      status: 200,
      message: 'Admin found',
      data: {
        id: user.id,
        username: user.username,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        contactNumber: user.contactNumber,
        role: user.role,
      },
    };
  } catch (e) {
    throw e;
  }
};

// services/userServices.ts (updated getUserDataService)

export const getUserDataService = async (
  userId: string
): Promise<{
  ok: boolean;
  status: number;
  message: string;
  data?: {
    id: string;
    firstname: string;
    lastname: string;
    username: string | null;
    email: string;
    isCareerPathChecked: boolean;
    image: string | null;
    role: Roles;
    gender: Gender | null;
    dob: Date | null;
    ageRange: string | null;
    region: string | null;
    bio: string | null;
    payment_plan: PaymentPlan | null;
    payment_plan_expires_at: Date | null;
    subscription_code: string | null;
    email_token: string | null;
    default_authorization: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
    passwordChangedAt: Date | null;
    eligibilityResults: EligibilityResult[];
    careerResults: CareerResult | null;
    transactions: Transaction[];
    userCards: UserCard[];
    userDirectDebits: UserDirectDebit[];
    actionHistories: ActionHistory[];
    ResultDocument: ResultDocument[];
    UserResponse: UserResponse[];
    interests: Interest[];
    skills: Skill[];
    subscriptionPlanStatus: boolean;
    schoolAccess: { schoolName: string; expiresAt: Date } | null;
  };
  errors?: { message: string }[];
}> => {
  try {
    const user = (await db.user.findUnique({
      where: { id: userId }, // Changed from { userId } to { id: userId }
      include: {
        eligibilityResults: true,
        careerResults: true,
        transactions: true,
        userCards: true,
        userDirectDebits: true,
        actionHistories: true,
        ResultDocument: true,
        UserResponse: true,
        // interests and skills include commented out; adjust based on schema
        // interests: { include: { interest: true } },
        // skills: { include: { skill: true } },
      },
    })) as UserWithRelations;

    if (!user) {
      return {
        ok: false,
        status: 404,
        message: 'User not found',
        errors: [{ message: 'User does not exist' }],
      };
    }

    const currentDate = new Date();
    const expiresAt = user.payment_plan_expires_at;
    const subscriptionPlanStatus =
      expiresAt !== null && new Date(expiresAt) > currentDate;
    // Students covered by a partner school: which school, and until when.
    // Only looked up for that plan, so nothing else depends on the new tables.
    const schoolAccess =
      user.payment_plan === 'SCHOOL_PARTNER'
        ? await getSchoolAccessForUser(user.id).catch(() => null)
        : null;
    return {
      ok: true,
      status: 200,
      message: 'User found',
      data: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        username: user.username,
        email: user.email,
        isCareerPathChecked: user.isCareerPathChecked,
        image: user.image,
        role: user.role,
        gender: user.gender,
        dob: user.dob,
        ageRange: user.ageRange,
        region: user.region,
        bio: user.bio,
        payment_plan: user.payment_plan,
        payment_plan_expires_at: user.payment_plan_expires_at,
        subscription_code: user.subscription_code,
        email_token: user.email_token,
        default_authorization: user.default_authorization,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        passwordChangedAt: user.passwordChangedAt,
        eligibilityResults: user.eligibilityResults,
        careerResults: user.careerResults,
        transactions: user.transactions,
        userCards: user.userCards,
        userDirectDebits: user.userDirectDebits,
        actionHistories: user.actionHistories,
        ResultDocument: user.ResultDocument,
        UserResponse: user.UserResponse,
        interests: user.interests,
        skills: user.skills,
        subscriptionPlanStatus,
        schoolAccess,
      },
    };
  } catch (e) {
    throw e;
  }
};
// getUserByEmailService was removed: it returned a whole customer record
// (cards, payments, results) to anyone who typed an email. Visitors now use
// lookupAccount in userController, which answers only yes or no.

export const updatePasswordService = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
) => {
  try {
    console.log('Checking user with ID:', userId);
    const existingUser = await getUserById(userId);
    if (!existingUser) {
      console.log('User not found for ID:', userId);
      return {
        ok: false,
        status: 403,
        message: 'User not found',
        errors: [{ message: 'User does not exist' }],
      };
    }

    // Verify current password
    console.log('Comparing current password for user:', existingUser.email);
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      existingUser.password
    );
    if (!isPasswordValid) {
      console.log('Current password mismatch');
      return {
        ok: false,
        status: 401,
        message: 'Invalid credentials',
        errors: [{ message: 'Current password is incorrect' }],
      };
    }

    // Validate new password and confirm password match
    console.log('Validating new password match:', {
      newPassword,
      confirmPassword,
    });
    if (newPassword !== confirmPassword) {
      console.log('New password and confirm password do not match');
      return {
        ok: false,
        status: 400,
        message: 'Password mismatch',
        errors: [{ message: 'New password and confirmation do not match' }],
      };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    console.log('Hashing new password, updating user:', userId);
    const updatedUser = await updateUser(userId, { password: hashedPassword, passwordChangedAt: new Date() });

    if (!updatedUser) {
      console.log('Update failed for user:', userId);
      return {
        ok: false,
        status: 500,
        message: 'Update failed',
        errors: [
          {
            message: 'Server error. Something went wrong at updateUserProfile',
          },
        ],
      };
    }

    console.log('Password updated successfully for user:', userId);
    return {
      ok: true,
      status: 200,
      message: 'successful',
      data: updatedUser,
    };
  } catch (e) {
    console.error('Error in updatePasswordService:', e);
    throw e;
  }
};

// export const updatePasswordService = async (
//   userId: string,
//   password: string
// ) => {
//   try {
//     const existingUser = await getUserById(userId);
//     if (!existingUser)
//       return {
//         ok: false,
//         status: 403,
//         message: 'User not found',
//         errors: [{ message: 'User does not exist' }],
//       };

//     const hashedPassword = await bcrypt.hash(password, 10);
//     const updatedUser = await updateUser(userId, { password: hashedPassword });

//     if (!updatedUser)
//       return {
//         ok: false,
//         status: 500,
//         message: 'Update failed',
//         errors: [
//           {
//             message: 'Server error. Something went wrong at updateUserProfile',
//           },
//         ],
//       };

//     return {
//       ok: true,
//       status: 200,
//       message: 'successful',
//       data: updatedUser,
//     };
//   } catch (e) {
//     throw e;
//   }
// };

// convert date before updating user profile

// export const updateUserProfileService = async (
//   userId: string,
//   filteredData: Record<string, any>
// ) => {
//   try {
//     if (!userId)
//       return {
//         ok: false,
//         status: 400,
//         message: 'Update failed',
//         errors: [{ message: 'Invalid user ID' }],
//       };

//     const existingUser = await getUserById(userId);
//     if (!existingUser) {
//       return {
//         ok: false,
//         status: 404,
//         message: 'User not found',
//         errors: [{ message: 'User does not exist' }],
//       };
//     }

//     // Parse dob to ensure it's a valid ISO-8601 string if it exists in filteredData
//     if (filteredData.dob) {
//       try {
//         filteredData.dob = parseDate(filteredData.dob);
//       } catch (error) {
//         return {
//           ok: false,
//           status: 400,
//           message: 'Invalid date format',
//           errors: [{ message: 'Date of birth format is incorrect' }],
//         };
//       }
//     }
//     // security measurements
//     const updatedUser = await updateUser(userId, filteredData);

//     if (!updatedUser)
//       return {
//         ok: false,
//         status: 500,
//         message: 'Update failed',
//         errors: [
//           {
//             message: 'Server error. Something went wrong at updateUserProfile',
//           },
//         ],
//       };

//     return {
//       ok: true,
//       status: 200,
//       message: 'User updated successfully',
//       data: {
//         id: updatedUser.id,
//         firstname: updatedUser.firstname,
//         lastname: updatedUser.lastname,
//         email: updatedUser.email,
//         image: updatedUser.image,
//         role: updatedUser.role,
//         gender: updatedUser.gender,
//         dob: updatedUser.dob,
//         region: updatedUser.region,
//         bio: updatedUser.bio,
//       },
//     };
//   } catch (e) {
//     throw e;
//   }
// };

// Updated updateUserProfileService to handle skill IDs and otherSkill

export const updateUserProfileService = async (
  userId: string,
  filteredData: Record<string, any>
) => {
  try {
    if (!userId) {
      return {
        ok: false,
        status: 400,
        message: 'Update failed',
        errors: [{ message: 'Invalid user ID' }],
      };
    }

    const existingUser = await getUserById(userId);
    if (!existingUser) {
      return {
        ok: false,
        status: 404,
        message: 'User not found',
        errors: [{ message: 'User does not exist' }],
      };
    }

    // Parse dob to ensure it's a valid ISO-8601 string if it exists in filteredData
    if (filteredData.dob) {
      try {
        filteredData.dob = parseDate(filteredData.dob);
      } catch (error) {
        return {
          ok: false,
          status: 400,
          message: 'Invalid date format',
          errors: [{ message: 'Date of birth format is incorrect' }],
        };
      }
    }

    // Handle skills if provided (array of skill IDs)
    let skillIds: string[] = [];
    if (filteredData.skills) {
      const skillsInput = Array.isArray(filteredData.skills)
        ? filteredData.skills
        : [filteredData.skills];

      // Validate that all skill IDs exist
      const validSkillIds = await Promise.all(
        skillsInput.map(async (skillId: string) => {
          const skill = await db.skill.findUnique({ where: { id: skillId } });
          if (!skill) {
            throw new Error(`Skill with ID ${skillId} not found`);
          }
          return skillId;
        })
      );
      skillIds = validSkillIds;

      // Update the user's skills relation
      await db.user.update({
        where: { id: userId },
        data: {
          skills: {
            set: skillIds.map((id) => ({ id })), // Overwrite existing skills with selected ones
          },
        },
      });

      // Remove skills from filteredData to avoid passing it to updateUser
      delete filteredData.skills;
    }

    // Handle otherSkill if provided
    if (filteredData.otherSkill !== undefined) {
      // Ensure otherSkill is a string or null/undefined
      if (
        filteredData.otherSkill !== null &&
        typeof filteredData.otherSkill !== 'string'
      ) {
        return {
          ok: false,
          status: 400,
          message: 'Invalid otherSkill format',
          errors: [{ message: 'otherSkill must be a string or null' }],
        };
      }
    }

    // Update the user profile with the remaining fields, including otherSkill
    const updatedUser = await updateUser(userId, filteredData);

    if (!updatedUser) {
      return {
        ok: false,
        status: 500,
        message: 'Update failed',
        errors: [
          {
            message: 'Server error. Something went wrong at updateUserProfile',
          },
        ],
      };
    }

    return {
      ok: true,
      status: 200,
      message: 'User updated successfully',
      data: {
        id: updatedUser.id,
        firstname: updatedUser.firstname,
        lastname: updatedUser.lastname,
        email: updatedUser.email,
        image: updatedUser.image,
        role: updatedUser.role,
        gender: updatedUser.gender,
        dob: updatedUser.dob,
        region: updatedUser.region,
        bio: updatedUser.bio,
        otherSkill: updatedUser.otherSkill, // Now included in the return type
        skills: updatedUser.skills,
        // skills: updatedUser.skills.map((skill) => ({
        //   id: skill.id,
        //   name: skill.name,
        // })),
      },
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes('Skill with ID')) {
      return {
        ok: false,
        status: 404,
        message: 'Invalid skill selection',
        errors: [{ message: e.message }],
      };
    }
    throw e;
  }
};

export const getUserActivityHistory = async (userId: string) => {
  const activity = await db.actionHistory.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    take: 10,
  });
  return { ok: true, status: 200, data: activity };
};
