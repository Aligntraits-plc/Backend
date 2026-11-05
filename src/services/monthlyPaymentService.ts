import Paystack from 'paystack-api';
import https from 'https';
import retry from 'async-retry';
import { db } from '../config/db';
import { createUser, getUserByEmail, updateUser } from '../models/userModel';
import { PaymentPlan, TransactionStatus, Roles } from '@prisma/client';
import { getCountryByIp } from '../lib/getCountryByIp';
import { addMonths } from 'date-fns'; // Add this library for precise month addition
import { sendMail } from './mailServices';
import { DebitTransactionStatus } from '../types/school-course-types';

const paystack = Paystack(process.env.PAYSTACK_SECRET_KEY || '');

// const PRICES: Record<PaymentPlan, number> = {
//   BASIC_ONETIME: 200000, // ₦2,000 in kobo
//   LOCAL_MONTHLY: 550000, // ₦5,500 in kobo
//   GLOBAL_MONTHLY: 950000, // ₦9,500 in kobo
// };

// Amounts in kobo (₦1 = 100 kobo) — must match frontend PaywallModal
// Amounts in kobo. BASIC_ONETIME is no longer sold (kept so old records still
// read correctly) and SCHOOL_PARTNER is never charged: a school code covers it.
const PRICES: Record<PaymentPlan, number> = {
  BASIC_ONETIME: 110000, // ₦1,100
  LOCAL_MONTHLY: 370000, // ₦3,700
  GLOBAL_MONTHLY: 550000, // ₦5,500
  SCHOOL_PARTNER: 0,
};

// actual aligntrait test paystack plan codes (NGN only)
const PAYSTACK_PLAN_CODES: Record<PaymentPlan, string> = {
  BASIC_ONETIME: '', // Not needed for one-time payments
  LOCAL_MONTHLY: 'PLN_ecyxncshvduhvce',
  GLOBAL_MONTHLY: 'PLN_dl04vz6m7ro235e',
  SCHOOL_PARTNER: '', // never charged
};

export const initializeBasicOneTimePayment = async (
  email: string,
  firstname: string,
  lastname: string,
  schoolLocation: string,
  paymentPlan: PaymentPlan,
  ip: string
) => {
  const currency = 'NGN';
  const amount = PRICES[paymentPlan];
  const callbackUrl = `https://www.aligntraits.com/payment/callback`;

  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser({
      data: {
        firstname,
        lastname,
        email,
        password: '',
        role: Roles.USER,
      },
    });
  }

  const reference = `one_${user.id}_${paymentPlan}_${Date.now()}`;
  await db.transaction.create({
    data: {
      userId: user.id,
      paymentPlan,
      amount: amount / 100,
      currency,
      reference,
      schoolLocation,
      status: TransactionStatus.PENDING,
    },
  });

  const paystackResponse = await retry(
    async () =>
      await paystack.transaction.initialize({
        email: user.email,
        amount,
        currency,
        reference,
        callback_url: callbackUrl,
        metadata: { userId: user.id, paymentPlan, schoolLocation },
        channels: ['card', 'bank_transfer'],
      }),
    { retries: 3, minTimeout: 1000, maxTimeout: 5000 }
  );

  return {
    ok: true,
    status: 200,
    message: 'Payment initialized',
    data: {
      authorization_url: paystackResponse.data.authorization_url,
      reference: paystackResponse.data.reference,
    },
  };
};

// Helper function to handle customer creation/fetching
async function getOrCreateCustomer(
  email: string,
  firstname: string,
  lastname: string
) {
  try {
    // First try to find existing customer
    const customers = await paystack.customer.list({ email });
    if (customers.data && customers.data.length > 0) {
      return customers.data[0];
    }

    // Create new customer if not found
    const newCustomer = await paystack.customer.create({
      email,
      first_name: firstname,
      last_name: lastname,
    });
    return newCustomer.data;
  } catch (error) {
    console.error('Error handling customer:', error);
    throw new Error('Failed to process customer');
  }
}

export const initializeMonthlySubscription = async (
  email: string,
  firstname: string,
  lastname: string,
  schoolLocation: string,
  paymentPlan: PaymentPlan,
  ip: string
) => {
  try {
    const currency = 'NGN';
    const amount = PRICES[paymentPlan];
    const callbackUrl = `https://www.aligntraits.com/payment/callback`;

    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser({
        data: {
          firstname,
          lastname,
          email,
          password: '',
          role: Roles.USER,
        },
      });
    }

    const reference = `sub_${user.id}_${paymentPlan}_${Date.now()}`;

    await db.transaction.create({
      data: {
        userId: user.id,
        paymentPlan,
        amount: amount / 100,
        currency,
        reference,
        schoolLocation,
        status: TransactionStatus.PENDING,
      },
    });

    // Get or create Paystack customer
    const customer = await retry(
      () => getOrCreateCustomer(user.email, user.firstname, user.lastname),
      { retries: 3 }
    );

    const paystackResponse = await retry(
      async () => {
        const params: any = {
          email: user.email,
          amount,
          currency,
          reference,
          callback_url: callbackUrl,
          metadata: {
            userId: user.id,
            paymentPlan,
            auto_renew: true,
          },
          channels: ['card'],
        };

        // For monthly plans, include the plan code
        if (paymentPlan !== 'BASIC_ONETIME') {
          params.plan = PAYSTACK_PLAN_CODES[paymentPlan];
        }

        return await paystack.transaction.initialize(params);
      },
      { retries: 3 }
    );

    return {
      ok: true,
      status: 200,
      message: 'Subscription payment initialized',
      data: {
        authorization_url: paystackResponse.data.authorization_url,
        reference: paystackResponse.data.reference,
      },
    };
  } catch (error: any) {
    console.error('Error initializing subscription:', error);
    return {
      ok: false,
      status: 500,
      message: 'Failed to initialize subscription',
      error: error.message,
    };
  }
};

interface DirectDebitWebhookData {
  authorization_code: string;
  bank: {
    code: string;
    name?: string;
  };
  account: {
    number: string;
  };
  customer: {
    email: string;
    code: string;
  };
  metadata?: {
    action?: string;
    userId?: string;
  };
}

export const verifySubscriptionPaymentService = async (
  reference: string,
  event: string,
  webhookData?: DirectDebitWebhookData
) => {
  try {
    const transaction = await db.transaction.findUnique({
      where: { reference },
    });
    if (!transaction) {
      return { ok: false, status: 404, message: 'Transaction not found' };
    }

    // Verify transaction
    let verification;
    console.log('1: Event:', event);
    console.log('2: Webhook Data:', JSON.stringify(webhookData, null, 2));

    if (event === 'direct_debit.authorization.created') {
      console.log(
        '3: ✅ Direct Debit Webhook Payload:',
        JSON.stringify(webhookData, null, 2)
      );
      if (!webhookData) {
        return {
          ok: false,
          status: 400,
          message: 'Webhook data is required for Direct Debit authorization',
        };
      }
      verification = { data: webhookData, status: 'success' };
    } else {
      verification = await paystack.transaction.verify({ reference });
    }

    if (
      verification.data.status !== 'success' &&
      event !== 'direct_debit.authorization.created'
    ) {
      console.error('4: Verification failed:', verification.data);
      return { ok: false, status: 400, message: 'Verification failed' };
    }

    const status =
      event === 'charge.success'
        ? TransactionStatus.SUCCESS
        : TransactionStatus.FAILED;
    await db.transaction.update({
      where: { reference },
      data: { status },
    });

    if (status !== TransactionStatus.SUCCESS) {
      return { ok: true, status: 200, message: 'Payment failed' };
    }

    const authorization = verification.data.authorization;
    const now = new Date();
    let expiresAt: Date;
    let subscriptionCode: string | null = null;
    let emailToken: string | null = null;
    let nextPaymentDate: Date | null = null;

    if (transaction.paymentPlan !== 'BASIC_ONETIME') {
      expiresAt = addMonths(now, 1);

      if (verification.data.subscription) {
        subscriptionCode = verification.data.subscription.subscription_code;
        emailToken = verification.data.subscription.email_token;
        nextPaymentDate = new Date(
          verification.data.subscription.next_payment_date
        );
        console.log(
          '5: Extracted from verification - subscription code:',
          subscriptionCode
        );
        console.log(
          '6: Extracted from verification - email token:',
          emailToken
        );
        console.log(
          '7: Extracted from verification - next payment date:',
          nextPaymentDate
        );
      } else {
        console.warn(
          '8: No subscription data in verification response, fetching subscription...'
        );
        const customer = await getOrCreateCustomer(
          verification.data.customer.email,
          verification.data.customer.first_name || '',
          verification.data.customer.last_name || ''
        );
        const subscriptions = await paystack.subscription.list({
          customer: customer.customer_code,
          plan: PAYSTACK_PLAN_CODES[transaction.paymentPlan],
        });
        console.log('9: Fetched subscriptions for customer:', subscriptions);

        const matchingSubscriptions = subscriptions.data.filter(
          (sub: any) =>
            sub.plan.plan_code ===
              PAYSTACK_PLAN_CODES[transaction.paymentPlan] &&
            sub.status === 'active'
        );
        const activeSubscription = matchingSubscriptions.sort(
          (a: any, b: any) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];

        if (activeSubscription) {
          subscriptionCode = activeSubscription.subscription_code;
          emailToken = activeSubscription.email_token;
          nextPaymentDate = new Date(activeSubscription.next_payment_date);
          console.log(
            '10: Fetched from subscription list - subscription code:',
            subscriptionCode
          );
          console.log(
            '11: Fetched from subscription list - email token:',
            emailToken
          );
          console.log(
            '12: Fetched from subscription list - next payment date:',
            nextPaymentDate
          );
        } else {
          console.error('13: No active subscription found for this plan');
        }
      }
    } else {
      expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes for one-time
    }

    if (event === 'direct_debit.authorization.created') {
      const authorizationCode = webhookData?.authorization_code || '';
      const bankCode = webhookData?.bank?.code || '';
      const accountNumber = webhookData?.account?.number || '';

      const existingDebit = await db.userDirectDebit.findFirst({
        where: { authorization_code: authorizationCode },
      });

      if (!existingDebit) {
        await db.userDirectDebit.create({
          data: {
            userId: transaction.userId,
            authorization_code: authorizationCode,
            bank_code: bankCode,
            account_number: accountNumber,
          },
        });
        console.log(
          '14: New direct debit added successfully:',
          authorizationCode
        );
      } else {
        console.log('15: Direct debit already exists:', authorizationCode);
      }

      return {
        ok: true,
        status: 200,
        message: 'Direct Debit authorization verified and added',
        data: { reference, status: 'success' },
      };
    }

    console.log('16: Updating user with:', {
      payment_plan: transaction.paymentPlan,
      payment_plan_expires_at: expiresAt,
      subscription_code: subscriptionCode,
      email_token: emailToken,
      default_authorization: authorization.authorization_code,
    });

    await updateUser(transaction.userId, {
      payment_plan: transaction.paymentPlan,
      payment_plan_expires_at: expiresAt,
      subscription_code: subscriptionCode,
      email_token: emailToken,
      default_authorization: authorization.authorization_code,
    });

    if (transaction.paymentPlan !== 'BASIC_ONETIME') {
      await db.userCard.updateMany({
        where: {
          userId: transaction.userId,
          subscription_status: 'ACTIVE',
        },
        data: {
          subscription_status: 'INACTIVE',
        },
      });

      await db.userCard.create({
        data: {
          userId: transaction.userId,
          authorization_code: authorization.authorization_code,
          last4: authorization.last4 || '',
          exp_month: authorization.exp_month?.toString().padStart(2, '0') || '',
          exp_year: authorization.exp_year?.toString() || '',
          brand: authorization.brand || '',
          reusable: authorization.reusable || false,
          subscription_code: subscriptionCode,
          email_token: emailToken,
          next_payment_date: nextPaymentDate,
          subscription_status: 'ACTIVE',
        },
      });
    } else {
      await db.userCard.create({
        data: {
          userId: transaction.userId,
          authorization_code: authorization.authorization_code,
          last4: authorization.last4 || '',
          exp_month: authorization.exp_month?.toString().padStart(2, '0') || '',
          exp_year: authorization.exp_year?.toString() || '',
          brand: authorization.brand || '',
          reusable: false,
        },
      });
    }

    // Send Payment Successful Email
    const host = process.env.WEBSITE_URL || 'http://localhost:3000';
    const user = await db.user.findUnique({
      where: { id: transaction.userId },
    });
    if (user) {
      const paymentEmailResult = await sendMail({
        from: 'Aligntraits <no-reply@aligntrait.com>',
        recipients: [user.email],
        subject: 'Payment Successful - AlignTraits',
        templateName: 'payment-successful-email',
        templateInfo: {
          name: `${user.firstname} ${user.lastname}`,
          transactionReference: reference,
          planType: transaction.paymentPlan,
          expiresAt: expiresAt,
          host,
        },
      });
      console.log('18: Payment Successful Email Result:', paymentEmailResult);
    }

    // Check email verification status and send Welcome Email if unverified
    const updatedUser = await db.user.findUnique({
      where: { id: transaction.userId },
    });
    if (updatedUser && !updatedUser.emailVerified) {
      const welcomeEmailResult = await sendMail({
        from: 'Aligntraits <no-reply@aligntrait.com>',
        recipients: [updatedUser.email],
        subject: 'Welcome to AlignTraits - Verify Your Email',
        templateName: 'welcome-unverified-email',
        templateInfo: {
          name: `${updatedUser.firstname} ${updatedUser.lastname}`,
          signupUrl: `${host}/setup-password?email=${updatedUser.email}`,
          host,
        },
      });
      console.log('19: Welcome Email Result:', welcomeEmailResult);
    }

    return {
      ok: true,
      status: 200,
      message: 'Payment verified and user updated',
      data: { reference, status: 'success' },
    };
  } catch (error: any) {
    console.error('17: Error verifying subscription:', error);
    return {
      ok: false,
      status: 500,
      message: 'Failed to verify subscription',
      error: error.message,
    };
  }
};

const updateUser1 = async (userId: string, data: any) => {};

export const cancelUserSubscription = async (userId: string) => {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.subscription_code || !user.email_token) {
    return {
      ok: false,
      status: 400,
      message: 'User has no active subscription',
    };
  }

  const response = await paystack.subscription.disable({
    code: user.subscription_code,
    token: user.email_token,
  });

  if (response.status !== true) {
    return { ok: false, status: 400, message: 'Cancellation failed' };
  }

  await updateUser(userId, {
    payment_plan: null,
    payment_plan_expires_at: null,
    subscription_code: null,
    email_token: null,
  });

  return { ok: true, status: 200, message: 'Subscription cancelled' };
};

// Get user cards
export const getUserCards = async (userId: string) => {
  const cards = await db.userCard.findMany({ where: { userId } });
  return { ok: true, status: 200, data: cards };
};

// Remove a specific card from user
export const removeCard = async (
  userId: string,
  authorization_code: string
) => {
  await db.userCard.deleteMany({
    where: {
      userId,
      authorization_code,
    },
  });
  return { ok: true, status: 200, message: 'Card removed' };
};

// Add a new card to user's subscription

export const addCardToSubscription = async (
  userId: string,
  email: string,
  ip: string
) => {
  try {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return { ok: false, status: 404, message: 'User not found' };
    }

    const reference = `addcard_${userId}_${Date.now()}`;
    const callbackUrl = `https://www.aligntraits.com/payment/callback`;

    // Determine currency and amount based on IP
    const region = getCountryByIp(ip);
    const isUsdEnabled = process.env.ENABLE_USD === 'true';
    const currency = isUsdEnabled && region !== 'Nigeria' ? 'USD' : 'NGN';

    // Define currency-specific amounts
    const amounts = {
      NGN: 100, // 100 NGN for Nigeria
      USD: 1, // 1 USD for other regions (adjust as needed)
    };
    const amount = amounts[currency];

    // Initialize card transaction
    const paystackCardResponse = await retry(
      async () =>
        await paystack.transaction.initialize({
          email,
          amount,
          currency,
          reference,
          callback_url: callbackUrl,
          metadata: { userId, action: 'add_card' },
          channels: ['card'],
        }),
      { retries: 3, minTimeout: 1000, maxTimeout: 5000 }
    );

    const cardAuthorizationUrl = paystackCardResponse.data.authorization_url;
    if (!cardAuthorizationUrl) {
      return {
        ok: false,
        status: 400,
        message: 'Failed to initialize card addition',
      };
    }

    return {
      ok: true,
      status: 200,
      message: 'Card addition initialized',
      data: {
        card_authorization_url: cardAuthorizationUrl,
        currency,
        amount,
        reference,
      },
    };
  } catch (error: any) {
    console.error('Error adding card:', error);
    return {
      ok: false,
      status: 500,
      message: 'Failed to add card',
      error: error.message,
    };
  }
};

export const handleChargeFailed = async (reference: string) => {
  try {
    const transaction = await db.transaction.findUnique({
      where: { reference },
    });
    if (!transaction || transaction.status === TransactionStatus.SUCCESS) {
      return;
    }

    const user = await db.user.findUnique({
      where: { id: transaction.userId },
    });
    if (!user) {
      console.error('User not found for transaction:', reference);
      return;
    }

    const userCards = await db.userCard.findMany({
      where: { userId: transaction.userId, reusable: true },
      orderBy: { createdAt: 'asc' },
    });

    // Retry with other cards
    for (const card of userCards) {
      if (card.authorization_code !== user.default_authorization) {
        const retryResponse = await paystack.transaction.charge({
          authorization_code: card.authorization_code,
          email: user.email,
          amount: transaction.amount * 100,
          currency: transaction.currency as 'NGN' | 'USD',
          reference: `retry_${Date.now()}_${reference}`,
        });

        if (retryResponse.data.status === 'success') {
          await db.transaction.update({
            where: { reference: transaction.reference },
            data: { status: TransactionStatus.SUCCESS },
          });
          await updateUser(transaction.userId, {
            default_authorization: card.authorization_code,
          });
          return;
        }
      }
    }

    // Fallback to Direct Debit if enabled and authorized
    if (process.env.ENABLE_DIRECT_DEBIT === 'true') {
      const userDirectDebit = await db.userDirectDebit.findFirst({
        where: { userId: transaction.userId },
      });
      if (userDirectDebit?.authorization_code) {
        const subscriptionCode = user.subscription_code; // Use from User table

        let chargeResponse;
        if (subscriptionCode) {
          // Update subscription to use Direct Debit authorization
          const updateSubscription = await paystack.subscription.update({
            code: subscriptionCode,
            authorization: userDirectDebit.authorization_code,
          });
          if (updateSubscription.data.status === 'active') {
            chargeResponse = await paystack.subscription.charge({
              code: subscriptionCode,
              amount: transaction.amount * 100,
            });
          }
        } else {
          // Fallback to one-off charge with Direct Debit
          chargeResponse = await paystack.transaction.charge({
            authorization_code: userDirectDebit.authorization_code,
            email: user.email,
            amount: transaction.amount * 100,
            currency: transaction.currency as 'NGN' | 'USD',
            reference: `debit_${Date.now()}_${reference}`,
          });
        }

        if (chargeResponse?.data.status === 'success') {
          await db.transaction.update({
            where: { reference: transaction.reference },
            data: { status: TransactionStatus.SUCCESS },
          });

          // Update userCard and default authorization
          const last4 = userDirectDebit.account_number?.slice(-4) || '';
          await db.userCard.upsert({
            where: { authorization_code: userDirectDebit.authorization_code },
            create: {
              userId: transaction.userId,
              authorization_code: userDirectDebit.authorization_code,
              last4,
              exp_month: '01', // Placeholder for Direct Debit
              exp_year: '2025', // Placeholder for Direct Debit
              brand: 'Direct Debit',
              reusable: true,
            },
            update: {
              last4,
              exp_month: '01', // Update placeholder
              exp_year: '2025', // Update placeholder
            },
          });

          // Update expiry date for monthly renewal
          const now = new Date();
          const expiresAt = addMonths(now, 1); // Match verifySubscriptionPaymentService logic

          await updateUser(transaction.userId, {
            default_authorization: userDirectDebit.authorization_code,
            subscription_code: subscriptionCode || null, // Sync with existing or null if none
            payment_plan_expires_at: expiresAt, // Update expiry date
          });
          console.log('Direct Debit successful:', reference);
        } else {
          console.warn('Direct Debit charge failed:', chargeResponse?.data);
        }
      }
    }
  } catch (error: any) {
    console.error('Error handling charge failed:', error);
  }
};

export const verifyDirectDebitService = async (
  reference: string,
  event: string,
  webhookData?: DirectDebitWebhookData
) => {
  try {
    console.log('1: Starting verification for reference:', reference);
    console.log('2: Event:', event);
    console.log('3: Webhook Data:', JSON.stringify(webhookData, null, 2));

    // Find the transaction first
    const transaction = await db.transaction.findUnique({
      where: { reference },
    });

    if (!transaction) {
      console.error('4: Transaction not found');
      return { ok: false, status: 404, message: 'Transaction not found' };
    }

    if (event === 'direct_debit.authorization.created') {
      console.log('5: Processing Direct Debit authorization');
      if (!webhookData) {
        console.error(
          '6: Webhook data is required for Direct Debit authorization'
        );
        return {
          ok: false,
          status: 400,
          message: 'Webhook data is required for Direct Debit authorization',
        };
      }

      // Validate required fields
      if (
        !webhookData.authorization_code ||
        !webhookData.customer?.email ||
        !webhookData.customer?.code
      ) {
        console.error('6: Missing required webhook data fields');
        return {
          ok: false,
          status: 400,
          message: 'Missing required webhook data fields',
        };
      }

      console.log(
        '7: Paystack webhook response:',
        JSON.stringify(webhookData, null, 2)
      );

      // Extract Direct Debit details
      const authorizationCode = webhookData.authorization_code;
      const bankCode = webhookData.bank?.code;
      const accountNumber = webhookData.account?.number;

      if (!authorizationCode) {
        console.error('6: Missing authorization_code in webhook data');
        return {
          ok: false,
          status: 400,
          message: 'Missing required webhook data fields',
        };
      }

      // Check if this debit already exists
      const existingDebit = await db.userDirectDebit.findFirst({
        where: { authorization_code: authorizationCode },
      });

      if (!existingDebit) {
        // Store the Direct Debit details
        await db.userDirectDebit.create({
          data: {
            userId: transaction.userId,
            authorization_code: authorizationCode,
            bank_code: bankCode,
            account_number: accountNumber,
          },
        });
        console.log(
          '8: New direct debit added successfully:',
          authorizationCode
        );
      } else {
        console.log('9: Direct debit already exists:', authorizationCode);
      }

      // No status update needed here; transaction remains PENDING until charged
      return {
        ok: true,
        status: 200,
        message: 'Direct Debit account details registered successfully',
        data: {
          reference,
          status: 'registered', // Descriptive response, not tied to enum
          authorization_code: authorizationCode,
          bank_code: bankCode,
          account_number: accountNumber,
        },
      };
    }

    // For non-direct debit events, perform regular verification
    console.log('10: Performing regular Paystack verification');
    const verification = await paystack.transaction.verify({ reference });
    console.log(
      '11: Paystack verification response:',
      JSON.stringify(verification, null, 2)
    );

    if (verification.data.status !== 'success') {
      console.error('12: Verification failed');
      return { ok: false, status: 400, message: 'Verification failed' };
    }

    // Update transaction status for successful charges
    await db.transaction.update({
      where: { reference },
      data: { status: TransactionStatus.SUCCESS },
    });

    console.log('13: Payment verified successfully');
    return {
      ok: true,
      status: 200,
      message: 'Payment verified',
      data: {
        reference,
        status: 'success',
        authorization: verification.data.authorization,
      },
    };
  } catch (error: any) {
    console.error('14: Error in verification:', {
      message: error.message,
      type: error.name,
      stack: error.stack,
    });
    return {
      ok: false,
      status: 500,
      message: 'Failed to verify payment',
      error: error.message,
    };
  }
};

export const addDirectDebitToSubscription = async (
  userId: string,
  email: string,
  ip: string
) => {
  try {
    console.log('1: Starting Direct Debit authorization for user:', userId);
    console.log('2: User email:', email);
    console.log('3: IP address:', ip);

    // Verify user exists (optional, only checks email)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true }, // Minimal check to confirm user
    });

    if (!user) {
      console.error('4: User not found');
      return { ok: false, status: 404, message: 'User not found' };
    }

    console.log('5: User verified with email:', user.email);

    const reference = `adddebit_${userId}_${Date.now()}`;
    const callbackUrl = `https://www.aligntraits.com/payment/callback`;

    // Determine currency (Direct Debit currently supports NGN only)
    const region = getCountryByIp(ip);
    const isUsdEnabled = process.env.ENABLE_USD === 'true';
    const currency = isUsdEnabled && region !== 'Nigeria' ? 'USD' : 'NGN';

    // Define currency-specific amounts
    const amounts = {
      NGN: 100,
      USD: 1,
    };
    const amount = amounts[currency];

    console.log('6: Currency determined:', currency);
    console.log('7: Amount set to:', amount);

    const directDebitParams = JSON.stringify({
      email,
      channel: 'direct_debit',
      callback_url: callbackUrl,
      metadata: {
        userId,
        action: 'add_debit',
        nonce: Date.now(),
      },
    });

    console.log('8: Paystack request params:', directDebitParams);

    const directDebitOptions = {
      hostname: 'api.paystack.co',
      port: 443,
      path: '/customer/authorization/initialize',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    console.log('9: Sending request to Paystack...');
    const directDebitPromise = new Promise<string>((resolve, reject) => {
      const req = https
        .request(directDebitOptions, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            const response = JSON.parse(data);
            console.log('10: Paystack response:', response);
            if (
              res.statusCode === 200 &&
              response.status &&
              response.data?.redirect_url
            ) {
              console.log(
                '11: Direct Debit authorization initialized successfully'
              );
              resolve(response.data.redirect_url);
            } else {
              console.error('12: Direct Debit initialization failed');
              reject(new Error(`Direct Debit initialization failed: ${data}`));
            }
          });
        })
        .on('error', (error) => {
          console.error('13: Request error:', error);
          reject(error);
        });

      req.write(directDebitParams);
      req.end();
    });

    const directDebitRedirectUrl = await directDebitPromise;
    console.log('14: Redirect URL:', directDebitRedirectUrl);

    return {
      ok: true,
      status: 200,
      message: 'Direct Debit authorization initialized',
      data: {
        direct_debit_redirect_url: directDebitRedirectUrl,
        currency,
        amount,
        reference,
      },
    };
  } catch (error: any) {
    console.error('15: Error in Direct Debit initialization:', error);
    return {
      ok: false,
      status: 500,
      message: 'Failed to initialize Direct Debit',
      error: error.message,
    };
  }
};
