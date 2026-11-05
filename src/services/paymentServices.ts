import Paystack from 'paystack-api';
import retry from 'async-retry';
import { db } from '../config/db';
import { createUser, getUserByEmail, updateUser } from '../models/userModel';
import { PaymentPlan, TransactionStatus, Roles } from '@prisma/client';
import { getCountryByIp } from '../lib/getCountryByIp';

const paystack = Paystack(process.env.PAYSTACK_SECRET_KEY || '');

// Pricing configuration by plan and currency (in kobo for NGN, cents for USD)
const PRICES: Record<PaymentPlan, { NGN: number; USD: number }> = {
  BASIC_ONETIME: { NGN: 200000, USD: 399 }, // ₦2,000, $3.99
  LOCAL_MONTHLY: { NGN: 550000, USD: 899 }, // ₦5,500, $8.99
  GLOBAL_MONTHLY: { NGN: 950000, USD: 1499 }, // ₦9,500, $14.99
  SCHOOL_PARTNER: { NGN: 0, USD: 0 }, // never charged: a school code covers it
};

// export const initializeSubscriptionPaymentService = async (
//   email: string,
//   firstname: string,
//   lastname: string,
//   schoolLocation: string,
//   paymentPlan: PaymentPlan,
//   ip: string
// ) => {
//   try {
//     // Validate email
//     if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
//       return {
//         ok: false,
//         status: 400,
//         message: 'Invalid email address',
//         errors: [{ message: 'Please provide a valid email' }],
//       };
//     }

//     // Validate payment plan
//     if (!Object.values(PaymentPlan).includes(paymentPlan)) {
//       return {
//         ok: false,
//         status: 400,
//         message: 'Invalid payment plan',
//         errors: [{ message: `Payment plan ${paymentPlan} is not supported` }],
//       };
//     }

//     // Validate callback URL
//     if (!process.env.APP_URL) {
//       return {
//         ok: false,
//         status: 500,
//         message: 'Server configuration error',
//         errors: [{ message: 'APP_URL is not configured' }],
//       };
//     }

//     // Determine currency
//     const region = getCountryByIp(ip);
//     const isUsdEnabled = process.env.ENABLE_USD === 'true';
//     const currency = isUsdEnabled && region !== 'Nigeria' ? 'USD' : 'NGN';
//     const amount = PRICES[paymentPlan][currency];
//     const callbackUrl = `https://www.aligntraits.com/payment/callback`;
//     // const callbackUrl = `${process.env.APP_URL}/payment/callback`;
//     console.log(
//       `IP: ${ip}, Region: ${region || 'Unknown'}, Currency: ${currency}, Amount: ${amount}, Callback URL: ${callbackUrl}`
//     );

//     // Check or create user
//     let user = await getUserByEmail(email);
//     if (!user) {
//       user = await createUser({
//         data: {
//           firstname,
//           lastname,
//           email,
//           password: '',
//           emailVerified: new Date(),
//           role: Roles.USER,
//         },
//       });
//     }

//     // Create transaction record
//     const reference = `sub_${user.id}_${paymentPlan}_${Date.now()}`;
//     const transaction = await db.transaction.create({
//       data: {
//         userId: user.id,
//         paymentPlan,
//         amount: amount / 100,
//         currency,
//         reference,
//         schoolLocation,
//         status: TransactionStatus.PENDING,
//       },
//     });

//     // Initialize Paystack transaction
//     const paystackResponse = await retry(
//       async () => {
//         return await paystack.transaction.initialize({
//           email: user.email,
//           amount,
//           currency,
//           reference,
//           callback_url: callbackUrl,
//           metadata: { userId: user.id, paymentPlan, schoolLocation },
//           channels: ['card', 'bank_transfer'],
//         });
//       },
//       {
//         retries: 3,
//         minTimeout: 1000,
//         maxTimeout: 5000,
//         onRetry: (error) => {
//           if (error && typeof error === 'object' && 'message' in error) {
//             console.log(
//               `Retrying Paystack initialize: ${(error as any).message}`
//             );
//           } else {
//             console.log('Retrying Paystack initialize: Unknown error');
//           }
//         },
//       }
//     );

//     console.log(`Paystack Response: ${JSON.stringify(paystackResponse.data)}`);

//     return {
//       ok: true,
//       status: 200,
//       message: 'Payment initialized',
//       data: {
//         authorization_url: paystackResponse.data.authorization_url,
//         reference: paystackResponse.data.reference,
//       },
//     };
//   } catch (error: any) {
//     console.error('Error in initializeSubscriptionPaymentService:', error);
//     return {
//       ok: false,
//       status: 500,
//       message: 'Failed to initialize payment',
//       errors: [{ message: error.message || 'Paystack transaction failed' }],
//     };
//   }
// };
// // services/paymentVerification.ts
// export const verifySubscriptionPaymentService = async (
//   reference: string,
//   event: string
// ) => {
//   const transaction = await db.transaction.findUnique({ where: { reference } });
//   if (!transaction)
//     return { ok: false, status: 404, message: 'Transaction not found' };

//   const status =
//     event === 'charge.success'
//       ? TransactionStatus.SUCCESS
//       : TransactionStatus.FAILED;
//   await db.transaction.update({ where: { reference }, data: { status } });

//   if (status !== TransactionStatus.SUCCESS)
//     return { ok: true, status: 200, message: 'Payment failed' };

//   const verification = await paystack.transaction.verify({ reference });
//   if (verification.data.status !== 'success') {
//     return { ok: false, status: 400, message: 'Verification failed' };
//   }

//   const expectedAmount = Math.round(transaction.amount * 100);
//   if (verification.data.amount !== expectedAmount) {
//     return { ok: false, status: 400, message: 'Amount mismatch' };
//   }

//   const now = new Date();
//   let expiresAt: Date;
//   if (transaction.paymentPlan === 'BASIC_ONETIME') {
//     expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
//   } else {
//     const durationDays = transaction.paymentPlan === 'GLOBAL_MONTHLY' ? 30 : 30;
//     expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
//   }

//   await updateUser(transaction.userId, {
//     payment_plan: transaction.paymentPlan,
//     payment_plan_expires_at: expiresAt,
//   });

//   return {
//     ok: true,
//     status: 200,
//     message: 'Payment verified and user updated',
//     data: { reference, status: 'success' },
//   };
// };

// Get all transaction records
export const getTransactionRecordsService = async () => {
  try {
    const transactions = await db.transaction.findMany({
      include: {
        user: {
          select: { id: true, email: true, payment_plan_expires_at: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      status: 200,
      message: 'Transaction records retrieved',
      data: transactions.map((t) => ({
        id: t.id,
        userId: t.userId,
        userEmail: t.user.email,
        paymentPlan: t.paymentPlan,
        amount: t.amount,
        currency: t.currency,
        reference: t.reference,
        payment_plan_expires_at: t.user.payment_plan_expires_at,
        status: t.status,
        createdAt: t.createdAt,
      })),
    };
  } catch (error: any) {
    console.error('Error in getTransactionRecordsService:', error);
    return {
      ok: false,
      status: 500,
      message: 'Failed to retrieve transaction records',
      errors: [{ message: error.message || 'Database query failed' }],
    };
  }
};
