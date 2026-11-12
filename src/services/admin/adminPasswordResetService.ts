import bcrypt from 'bcryptjs';
import { getUserByEmail, updateUser } from '../../models/userModel';
import {
  getEmailVerificationTokenByEmail,
  saveEmailVerificationToken,
  deleteEmailVerificationToken,
} from '../../models/tokenModel';
import { generateOTP } from '../../lib/utils';
import { sendResetPasswordEmail } from '../mailServices';
import MessageResponse from '../../types/messageResponse';
import { isStaffLogin } from '../roles';

const requestAdminResetService = async (
  email: string
): Promise<MessageResponse> => {
  const user = await getUserByEmail(email);
  if (!user || !isStaffLogin(user)) {
    throw new Error('Admin does not exist');
  }

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
    name: user.firstname || 'Admin',
    email,
    token: otp,
  });

  if (!emailRes.ok) {
    throw new Error('Failed to send reset email');
  }

  return {
    ok: true,
    message: `We’ve sent an email to ${email} with a link to get back into your account`,
    data: { email },
  };
};

const verifyAdminResetTokenService = async ({
  email,
  token,
}: {
  email: string;
  token: string;
}): Promise<MessageResponse> => {
  const tokenRecord = await getEmailVerificationTokenByEmail(email);
  if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
    throw new Error('Invalid or expired token');
  }

  const isMatch = await bcrypt.compare(token, tokenRecord.otp);
  if (!isMatch) {
    throw new Error('Invalid token');
  }

  const user = await getUserByEmail(email);
  if (!user || !isStaffLogin(user)) {
    throw new Error('Admin not found');
  }

  return {
    ok: true,
    message: 'Token is valid',
    data: { email },
  };
};

const resetAdminPasswordService = async ({
  email,
  token,
  newPassword,
  confirmPassword,
}: {
  email: string;
  token: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<MessageResponse> => {
  if (newPassword !== confirmPassword) {
    throw new Error(
      'Passwords do not match. Please ensure both password fields are identical.'
    );
  }

  if (
    newPassword.length < 8 ||
    !/[A-Z]/.test(newPassword) ||
    !/[a-z]/.test(newPassword) ||
    !/[0-9]/.test(newPassword) ||
    !/[^A-Za-z0-9]/.test(newPassword)
  ) {
    throw new Error(
      'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and special characters'
    );
  }

  const tokenRecord = await getEmailVerificationTokenByEmail(email);
  if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
    throw new Error('Invalid or expired token');
  }

  const isMatch = await bcrypt.compare(token, tokenRecord.otp);
  if (!isMatch) {
    throw new Error('Invalid token');
  }

  const user = await getUserByEmail(email);
  if (!user || !isStaffLogin(user)) {
    throw new Error('Admin not found');
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  const [updatedData] = await Promise.all([
    updateUser(user.id, { password: hashedPassword }),
    deleteEmailVerificationToken(email),
  ]);

  if (!updatedData) {
    throw new Error('Server error during password update');
  }

  return {
    ok: true,
    message: 'Admin Password Reset successful',
    data: { email },
  };
};

export {
  requestAdminResetService,
  verifyAdminResetTokenService,
  resetAdminPasswordService,
};
