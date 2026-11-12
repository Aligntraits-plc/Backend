// import { sendAdminSetupEmail } from './mailService'; // Import your email service
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import {
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
} from '../models/userModel';
import {
  getEmailVerificationTokenByEmail,
  deleteEmailVerificationToken,
  saveEmailVerificationToken,
  getEmailVerificationTokenByToken,
  countRecentTokens,
} from '../models/tokenModel';
import { generateOTP } from '../lib/utils';
import {
  sendConfirmationEmail,
  sendResetPasswordEmail,
  sendSetPasswordEmail,
} from './mailServices';

dotenv.config();

// Reset and set-password emails: at most this many per address per hour, so
// nobody can flood a student's inbox or guess codes at scale.
const EMAILS_PER_HOUR = 5;

const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN', 'CONTENT_MANAGER', 'ANALYST', 'COUNSELLOR'];

// Emails are stored exactly as people typed them, so only trim spaces here.
const normaliseEmail = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

const looksLikeEmail = (value: string) =>
  value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const tooManyRecentEmails = async (email: string) =>
  (await countRecentTokens(email, new Date(Date.now() - 60 * 60 * 1000))) >=
  EMAILS_PER_HOUR;

const loginAdminService = async ({
  email,
  password,
}: {
  email: string;
  password: string;
}) => {
  try {
    if (!email || !password) {
      return {
        status: 400,
        message: 'Login failed',
        errors: [{ message: 'Email and password are required' }],
      };
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return {
        ok: false,
        status: 404,
        message: 'Login failed',
        errors: [{ message: 'Admin does not exist' }],
      };
    }

    // Check if the user has an admin role
    if (!STAFF_ROLES.includes(user.role)) {
      return {
        ok: false,
        status: 403,
        message: 'Login failed',
        errors: [{ message: 'You are not authorized to log in as an admin' }],
      };
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return {
        ok: false,
        status: 400,
        message: 'Login failed',
        errors: [{ message: 'Invalid password' }],
      };
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' }
    );
    return {
      ok: true,
      status: 200,
      message: 'Login successful',
      data: { token },
    };
  } catch (e) {
    throw e;
  }
};

const registerAdminService = async ({
  username, // firstname i couldn't add username to d db, i had to convert username to first and send back
  email,
}: {
  username: string;
  email: string;
}) => {
  try {
    // Validate fields
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return {
        status: 400,
        message: 'Registration failed',
        errors: [{ message: 'User already exists' }],
      };
    }

    if (!looksLikeEmail(normaliseEmail(email))) {
      return {
        status: 400,
        message: 'Registration failed',
        errors: [{ message: 'Enter a valid email address' }],
      };
    }

    // A random password nobody knows. The new admin sets their own with
    // "Forgot password" on the admin login page, which emails them a link.
    // (This used to be the JWT secret, which made every new admin share one
    // guessable password and exposed the secret that signs every login.)
    const hashedPassword = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      10
    );

    const newUser = await createUser({
      data: {
        username: username,
        firstname: 'admin name',
        lastname: 'admin user',
        email: email,
        role: 'ADMIN',
        password: hashedPassword,
      },
    });

    // Send setup email with link to create password
    // await sendAdminSetupEmail(newUser);

    return {
      status: 201,
      message:
        'Admin created. Ask them to use "Forgot password" on the admin login page to set their password.',
      data: {
        id: newUser.id,
        username: newUser.username,
        lastname: newUser.lastname,
        email: newUser.email,
        role: newUser.role,
        createdAt: newUser.createdAt,
      },
    };
  } catch (e) {
    console.log(e);
    throw e;
  }
};

const addAdminPasswordService = async ({
  email,
  newPassword,
}: {
  email: string;
  newPassword: string;
}) => {
  try {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return {
        status: 400,
        message: 'Failed To Add Admin Password',
        errors: [{ message: 'Password must be at least 8 characters' }],
      };
    }

    const user = await getUserByEmail(normaliseEmail(email));
    // Only admin panel accounts. Student passwords are never set this way.
    if (!user || !STAFF_ROLES.includes(user.role)) {
      return {
        status: 404,
        message: 'Failed To Add Admin Password',
        errors: [{ message: 'Admin not found' }],
      };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const [updatedData] = await Promise.all([
      updateUser(user.id, {
        password: hashedPassword,
        passwordChangedAt: new Date(),
      }),
    ]);

    if (!updatedData) {
      return {
        status: 500,
        message: 'Failed To Add Admin Password',
        errors: [
          { message: 'Server error. Something went wrong at admin Update' },
        ],
      };
    }

    return {
      status: 200,
      message: 'Password Added successfully',
      data: { email },
    };
  } catch (e) {
    throw e;
  }
};

//admin service ends

const loginService = async ({
  email,
  password,
}: {
  email: string;
  password: string;
}) => {
  try {
    if (!email || !password) {
      return {
        status: 400,
        message: 'Login failed',
        errors: [{ message: 'Email and password are required' }],
      };
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return {
        ok: false,
        status: 404,
        message: 'Login failed',
        errors: [{ message: 'User does not exist' }],
      };
    }

    // Accounts made by the quiz, a check or a payment have no password yet.
    // The site sends them to the set-password page (a code is emailed there).
    if (!user.password) {
      return {
        ok: false,
        status: 400,
        code: 'PASSWORD_NOT_SET',
        message: 'Login failed',
        errors: [{ message: 'Password not set. Please set your password.' }],
      };
    }

    if (!user.emailVerified) {
      await emailVerificationService(user.email); // Resend the verification email
      return {
        ok: false,
        status: 403,
        message: 'Login failed',
        errors: [
          {
            message:
              "Email has not been verified. We've send a new one to your email",
          },
        ],
      };
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return {
        ok: false,
        status: 400,
        message: 'Login failed',
        errors: [{ message: 'Invalid password' }],
      };
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );
    await updateUser(user.id, { lastLoginAt: new Date() });
    return {
      ok: true,
      status: 200,
      message: 'Login successful',
      data: { token },
    };
  } catch (e) {
    throw e;
  }
};

const registerService = async ({
  firstname,
  lastname,
  email,
  password,
}: {
  firstname: string;
  lastname: string;
  email: string;
  password: string;
}) => {
  // Validate fields if (!password) { return { status: 400, message: 'Registration failed', errors: [{ message: 'Password is required' }], }; }

  try {
    // validate fields
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return {
        status: 400,
        message: 'Registration failed',
        errors: [{ message: 'User already exist' }],
      };
    }

    // hashpassword
    const hashedPassword = await bcrypt.hash(password, 10);

    // save into database
    const newUser = await createUser({
      data: {
        firstname: firstname,
        email,
        lastname: lastname,
        password: hashedPassword,
      },
    });

    // send verification email
    const response = await emailVerificationService(newUser.email);

    return {
      status: 201,
      message: 'Registration successful',
      data: {
        id: newUser.id,
        firstname: newUser.firstname,
        email: newUser.email,
        role: newUser.role,
        createdAt: newUser.createdAt,
        // emailSent: response?.didEmailSend,
        emailSent: response?.ok ?? false,
      },
    };
  } catch (e) {
    console.log(e, 3239);
    throw e;
  }
};

const validateTokenService = async ({
  email,
  token,
}: {
  email: string;
  token: string;
}) => {
  try {
    if (!email || !token)
      return {
        ok: false,
        status: 400,
        message: 'Invalid inputs',
      };

    const user = await getUserByEmail(email);

    if (user?.emailVerified || !user) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Email already verified' }],
      };
    }

    const tokenRecord = await getEmailVerificationTokenByEmail(email);
    if (!tokenRecord) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Invalid OTP or OTP expired' }],
      };
    }

    const isMatch = await bcrypt.compare(token.toString(), tokenRecord.otp);
    if (!isMatch) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Invalid OTP or OTP expired' }],
      };
    }

    const update = Promise.all([
      await updateUser(user?.id, { emailVerified: new Date() }),
      await deleteEmailVerificationToken(email),
    ]);

    return { ok: true, status: 200, message: 'Token is valid' };
  } catch (e) {
    throw e;
  }
};

// The reset code goes to the inbox only. The reply is the same whether or not
// the email has an account, so this cannot be used to find out who is a customer,
// and it never contains the code (it used to, which let anyone reset any password).
const requestResetService = async (rawEmail: string) => {
  const generic = {
    ok: true,
    status: 200,
    message:
      'If this email has an AlignTraits account, we have sent a link to reset the password. Check your inbox and spam folder.',
  };
  try {
    const email = normaliseEmail(rawEmail);
    if (!looksLikeEmail(email)) {
      return {
        ok: false,
        status: 400,
        message: 'Enter a valid email address',
        errors: [{ message: 'Enter a valid email address' }],
      };
    }

    const user = await getUserByEmail(email);
    if (!user) return generic;
    if (await tooManyRecentEmails(email)) return generic;

    const otp = generateOTP(12);
    const expirationTime = new Date(Date.now() + 7 * 60 * 1000); // 7 minutes
    const encryptedToken = await bcrypt.hash(otp, 10);

    await saveEmailVerificationToken({
      id: '',
      otp: encryptedToken,
      email,
      expirationTime,
    });

    const emailRes = await sendResetPasswordEmail({
      name: user.firstname || 'there',
      email,
      token: otp,
    });
    if (!emailRes.ok) {
      console.error('Reset email could not be sent:', emailRes.message);
    }

    return generic;
  } catch (e) {
    throw e;
  }
};

// const resetPasswordService = async ({
//   email,
//   token,
//   newPassword,
// }: {
//   email: string;
//   token: string;
//   newPassword: string;
// }) => {
//   try {
//     const otpRecord = await getEmailVerificationTokenByToken(token);
//     if (!otpRecord || !(await bcrypt.compare(token, otpRecord?.otp))) {
//       return {
//         status: 400,
//         message: 'Password Reset failed',
//         errors: [{ message: 'Invalid OTP or OTP expired' }],
//       };
//     }

//     const user = await getUserByEmail(email);
//     if (!user) {
//       return {
//         status: 404,
//         message: 'Password Reset failed',
//         errors: [{ message: 'User not found' }],
//       };
//     }

//     const hashedPassword = await bcrypt.hash(newPassword, 10);
//     // const existingUser = await getUserByEmail(email);

//     const [updatedData] = await Promise.all([
//       updateUser(user?.id, { password: hashedPassword }),
//       deleteEmailVerificationToken(email),
//     ]);
//     if (!updatedData) {
//       return {
//         status: 500,
//         message: 'Password Reset failed',
//         errors: [
//           { message: 'Server error. Something went wrong at updateUser' },
//         ],
//       };
//     }

//     return {
//       status: 200,
//       message: 'Password Reset successful',
//       data: { email },
//     };
//   } catch (e) {
//     throw e;
//   }
// };

const resetPasswordService = async ({
  email,
  token,
  newPassword,
}: {
  email: string;
  token: string;
  newPassword: string;
}) => {
  try {
    if (!email || !token || typeof newPassword !== 'string' || newPassword.length < 8) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Use the link we emailed you and a password of at least 8 characters' }],
      };
    }
    // const otpRecord = await getEmailVerificationTokenByToken(token);
    const tokenRecord = await getEmailVerificationTokenByEmail(email);

    if (!tokenRecord) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Invalid OTP or OTP expired' }],
      };
    }

    const isMatch = await bcrypt.compare(token.toString(), tokenRecord.otp);
    if (!isMatch) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        errors: [{ message: 'Invalid OTP or OTP expired' }],
      };
    }

    // if (!otpRecord || !(await bcrypt.compare(token, otpRecord.otp))) {
    //   return {
    //     status: 400,
    //     message: 'Password Reset failed',
    //     errors: [{ message: 'Invalid OTP or OTP expired' }],
    //   };
    // }

    const user = await getUserByEmail(email);
    if (!user) {
      return {
        status: 404,
        message: 'Password Reset failed',
        errors: [{ message: 'User not found' }],
      };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const [updatedData] = await Promise.all([
      updateUser(user.id, {
        password: hashedPassword,
        passwordChangedAt: new Date(),
        // The link was opened from their inbox, so the email is proven.
        ...(user.emailVerified ? {} : { emailVerified: new Date() }),
      }),
      deleteEmailVerificationToken(email),
    ]);

    if (!updatedData) {
      return {
        status: 500,
        message: 'Password Reset failed',
        errors: [
          { message: 'Server error. Something went wrong at updateUser' },
        ],
      };
    }

    return {
      status: 200,
      message: 'Password Reset successful',
      data: { email },
    };
  } catch (e) {
    throw e;
  }
};

const emailVerificationService = async (email: string) => {
  try {
    console.log('starting...');
    const existingUser = await getUserByEmail(email);
    if (!existingUser) return null;

    const existingToken = await getEmailVerificationTokenByEmail(email);

    // Generate and hash the OTP
    const otp = generateOTP(12);
    const expirationTime = new Date(Date.now() + 7 * 60 * 1000); // 7 minutes from creation

    const encryptedToken = await bcrypt.hash(otp, 10);

    const savedToken = await saveEmailVerificationToken({
      id: existingToken?.id ?? '',
      otp: encryptedToken,
      email,
      expirationTime,
    });

    // Never log the code itself: anyone who can read the logs could use it.
    const emailRes = await sendConfirmationEmail({
      name: existingUser.firstname,
      email: existingUser.email,
      otp,
    });

    return {
      // ok: true,
      ok: emailRes.ok,
      // status: 200,
      status: emailRes.status,
      didEmailSend: emailRes.ok,
      data: { otp, token: { ...savedToken } },
      message: emailRes.message,
      error: emailRes.error,
    };
  } catch (e) {
    throw e;
  }
};

const profileSchema = z.object({
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
});

const requestSchema = z.object({
  data: profileSchema, // Expect a nested 'data' object
});

const updateAdminProfileService = async (adminId: string, requestData: any) => {
  try {
    // Parse the outer request object to extract the nested 'data'
    const { data } = requestSchema.parse(requestData);
    const parsedData = profileSchema.parse(data); // Validate the inner data

    // Find user by ID
    const currentUser = await getUserById(adminId);

    // Check if user exists and is an admin
    if (!currentUser || !STAFF_ROLES.includes(currentUser.role)) {
      return {
        status: 404,
        message: 'Admin user not found or not authorized',
      };
    }

    // Prepare update data, only including fields that were provided
    const updateData: Partial<typeof parsedData> = {};

    if (parsedData.firstname !== undefined) {
      updateData.firstname = parsedData.firstname;
    }
    if (parsedData.lastname !== undefined) {
      updateData.lastname = parsedData.lastname;
    }

    if (
      parsedData.email !== undefined &&
      parsedData.email !== currentUser.email
    ) {
      // Check if the new email is already in use
      const emailCheck = await getUserByEmail(parsedData.email);
      if (emailCheck && emailCheck.id !== adminId) {
        return {
          status: 400,
          message: 'Email is already in use by another user',
        };
      }
      updateData.email = parsedData.email;
    }

    if (parsedData.contactNumber !== undefined) {
      updateData.contactNumber = parsedData.contactNumber;
    }

    // Only proceed with update if there's something to update
    if (Object.keys(updateData).length === 0) {
      return {
        status: 400,
        message: 'No valid fields provided for update',
      };
    }

    const updatedUser = await updateUser(adminId, updateData);

    if (!updatedUser) {
      return {
        status: 500,
        message: 'Failed to update profile',
        errors: [{ message: 'Server error during update' }],
      };
    }

    return {
      status: 200,
      message: 'Your profile has been successfully updated',
      data: {
        id: updatedUser.id,
        firstname: updatedUser.firstname,
        lastname: updatedUser.lastname,
        email: updatedUser.email,
        contactNumber: updatedUser.contactNumber,
      },
    };
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return {
        status: 400,
        message: 'Validation failed',
        errors: e.errors.map((err: { message: any }) => ({
          message: err.message,
        })),
      };
    }
    throw e;
  }
};

// Password validation schema
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(
        /[^A-Za-z0-9]/,
        'Password must contain at least one special character'
      ),
    confirmPassword: z.string().optional(), // Changed to optional
  })
  .refine(
    (data) =>
      !data.confirmPassword || data.newPassword === data.confirmPassword, // Only check if provided
    {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    }
  );

const updateAdminPasswordService = async (adminId: string, data: any) => {
  try {
    const parsedData = passwordSchema.parse(data);

    const user = await getUserByEmail(data.email);
    if (
      !user ||
      user.id !== adminId ||
      !STAFF_ROLES.includes(user.role)
    ) {
      return {
        status: 404,
        message: 'User not found or not authorized',
      };
    }

    const isValid = await bcrypt.compare(
      parsedData.currentPassword,
      user.password
    );
    if (!isValid) {
      return {
        status: 400,
        message: 'Current password is incorrect',
      };
    }

    const hashedPassword = await bcrypt.hash(parsedData.newPassword, 10);

    const updatedUser = await updateUser(adminId, { password: hashedPassword });
    if (!updatedUser) {
      return {
        status: 500,
        message: 'Failed to update password',
        errors: [{ message: 'Server error during update' }],
      };
    }

    return {
      status: 200,
      message: 'Your password has been updated successfully',
    };
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return {
        status: 400,
        message: 'Validation failed',
        errors: e.errors.map((err: { message: any }) => ({
          message: err.message,
        })),
      };
    }
    throw e;
  }
};

// Wrong set-password codes per email. After 5, the code is cancelled and the
// student asks for a new one, so a 6 digit code cannot be guessed.
// (Kept in memory: it resets if the server restarts, which only gives a few
// more tries, never access.)
const MAX_SETUP_TRIES = 5;
const setupFailures = new Map<string, number>();

// Step 1 for visitors who used the quiz, a check or a payment before they had
// a password: email a 6 digit code, plus a link to /setup-password that
// carries the same code. Typing the code keeps them in the same browser tab,
// so their results can load straight after.
// The reply is the same for every email, so it reveals nothing about accounts.
const sendSetupLinkService = async (rawEmail: string) => {
  const generic = {
    ok: true,
    status: 200,
    message:
      'If this email needs a password, we have sent a link to set one. Check your inbox and spam folder.',
  };
  const email = normaliseEmail(rawEmail);
  if (!looksLikeEmail(email)) {
    return {
      ok: false,
      status: 400,
      message: 'Enter a valid email address',
      errors: [{ message: 'Enter a valid email address' }],
    };
  }

  const user = await getUserByEmail(email);
  // Accounts that already have a password use "Forgot password" instead.
  if (!user || user.password) return generic;
  if (await tooManyRecentEmails(email)) return generic;

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  setupFailures.delete(email);
  await saveEmailVerificationToken({
    id: '',
    otp: await bcrypt.hash(code, 10),
    email,
    expirationTime: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
  });

  const emailRes = await sendSetPasswordEmail({
    name: user.firstname || 'there',
    email,
    token: code,
  });
  if (!emailRes.ok) {
    console.error('Set password email could not be sent:', emailRes.message);
  }
  return generic;
};

// Step 2: the code from the emailed link plus the new password.
// Refused without a valid code, and refused for any account that already has a
// password, so it can no longer be used to take over someone else's account.
const addPasswordAfterEligibiltyService = async ({
  email: rawEmail,
  password,
  token,
}: {
  email: string;
  password: string;
  token?: string;
}) => {
  try {
    const email = normaliseEmail(rawEmail);
    const invalidLink = {
      ok: false,
      status: 400,
      message: 'Password addition failed',
      errors: [
        {
          message:
            'This code is invalid or has expired. Ask for a new code.',
        },
      ],
    };

    if (!email || typeof password !== 'string' || password.length < 8) {
      return {
        ok: false,
        status: 400,
        message: 'Password addition failed',
        errors: [
          { message: 'Enter your email and a password of at least 8 characters' },
        ],
      };
    }
    if (!token || typeof token !== 'string') {
      return {
        ok: false,
        status: 400,
        message: 'Password addition failed',
        errors: [
          { message: 'Enter the 6 digit code we emailed you.' },
        ],
      };
    }

    const user = await getUserByEmail(email);
    if (!user) return invalidLink;

    if (user.password) {
      return {
        ok: false,
        status: 409,
        message: 'Password addition failed',
        errors: [
          {
            message:
              'This account already has a password. Use "Forgot password" to change it.',
          },
        ],
      };
    }

    const tokenRecord = await getEmailVerificationTokenByEmail(email);
    if (!tokenRecord) return invalidLink;
    if (!(await bcrypt.compare(token.trim(), tokenRecord.otp))) {
      const tries = (setupFailures.get(email) ?? 0) + 1;
      if (tries >= MAX_SETUP_TRIES) {
        setupFailures.delete(email);
        await deleteEmailVerificationToken(email);
        return {
          ok: false,
          status: 400,
          message: 'Password addition failed',
          errors: [
            {
              message:
                'Too many wrong codes, so that code has been cancelled. Ask for a new code.',
            },
          ],
        };
      }
      setupFailures.set(email, tries);
      return {
        ok: false,
        status: 400,
        message: 'Password addition failed',
        errors: [
          {
            message: `That code is not right. ${MAX_SETUP_TRIES - tries} tries left.`,
          },
        ],
      };
    }
    setupFailures.delete(email);

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();
    await updateUser(user.id, {
      password: hashedPassword,
      passwordChangedAt: now,
      lastLoginAt: now,
      // Opening the link proves they own this inbox.
      ...(user.emailVerified ? {} : { emailVerified: now }),
    });
    await deleteEmailVerificationToken(email);

    // Log them straight in, so they land on their results without a second step.
    const loginToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    return {
      ok: true,
      status: 200,
      message: 'Password set. You are now logged in.',
      data: { token: loginToken },
    };
  } catch (e) {
    throw e;
  }
};

export {
  loginService,
  registerService,
  validateTokenService,
  requestResetService,
  resetPasswordService,
  emailVerificationService,
  // admin auth service
  loginAdminService,
  registerAdminService,
  addAdminPasswordService,
  updateAdminPasswordService,
  updateAdminProfileService,
  addPasswordAfterEligibiltyService,
  sendSetupLinkService,
};
