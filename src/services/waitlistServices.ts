import { db } from '../config/db';
import { sendMail } from './mailServices';

const addToWaitlist = async ({ email }: { email: string }) => {
  try {
    if (!email) {
      return {
        status: 400, // Bad Request
        message: 'Email is required to add to the waitlist',
      };
    }
    // Check if the email is already registered in the waitlist
    const existingWaitlist = await db.waitList.findUnique({
      where: { email },
    });

    if (existingWaitlist) {
      return {
        status: 409, // Conflict
        message: 'This email is already registered on the waitlist',
        data: {
          id: existingWaitlist.id,
          email: existingWaitlist.email,
          createdAt: existingWaitlist.createdAt,
        },
      };
    }

    // Save new entry into the database
    const wait_list = await db.waitList.create({
      data: { email },
    });

    // Define your host, e.g., from environment variables or directly
    const host = process.env.BACKEND_URL || 'http://localhost:3000';

    // Send verification email
    const sent = await sendMail({
      recipients: [email],
      subject: 'You are on the AlignTraits list',
      templateName: 'waitList', // Make sure this matches your template name
      templateInfo: { email, host }, // Ensure host is included here
    });

    if (!sent.ok) {
      console.error('Error sending email:', sent.message);
      return { status: sent.status, message: 'Server error: ' + sent.message };
    }

    return {
      status: 201,
      message: 'Successful',
      data: {
        id: wait_list.id,
        email: wait_list.email,
        createdAt: wait_list.createdAt,
      },
    };
  } catch (e) {
    console.error('Error adding to waitlist:', e);
    throw e;
  }
  // No db.$disconnect() here: the database connection is shared by every request,
  // and closing it after each sign-up made other people's requests fail.
};

export { addToWaitlist };
