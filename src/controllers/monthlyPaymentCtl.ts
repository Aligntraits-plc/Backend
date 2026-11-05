import { Request, Response, NextFunction } from 'express';
import {
  initializeBasicOneTimePayment,
  initializeMonthlySubscription,
  verifySubscriptionPaymentService,
  cancelUserSubscription,
  getUserCards,
  removeCard,
  handleChargeFailed,
  addCardToSubscription,
  addDirectDebitToSubscription,
  verifyDirectDebitService,
} from '../services/monthlyPaymentService';
import { createHmac } from 'crypto';
import { getClientIp } from 'request-ip';
import { PaymentPlan } from '@prisma/client';

const ONE_TIME_PLAN_ON_SALE = false;

export const initOneTimePayment = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // The ₦1,100 one-time plan is no longer sold. Students who bought it keep it.
    // Set ONE_TIME_PLAN_ON_SALE to true to sell it again.
    if (!ONE_TIME_PLAN_ON_SALE) {
      return res.status(410).json({
        ok: false,
        message:
          'The one-time plan is no longer available. Choose a monthly plan, or use a code from your school.',
      });
    }

    const { email, firstname, lastname, schoolLocation, paymentPlan } =
      req.body;

    if (!email || !firstname || !lastname || !schoolLocation || !paymentPlan) {
      return res.status(400).json({
        ok: false,
        message:
          'Email, firstname, lastname, schoolLocation, and paymentPlan are required',
      });
    }

    const ip = getClientIp(req) || '127.0.0.1';
    const result = await initializeBasicOneTimePayment(
      email,
      firstname,
      lastname,
      schoolLocation,
      paymentPlan as PaymentPlan,
      ip
    );
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const initMonthlySubscription = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, firstname, lastname, schoolLocation, paymentPlan } =
      req.body;

    if (!email || !firstname || !lastname || !schoolLocation || !paymentPlan) {
      return res.status(400).json({
        ok: false,
        message:
          'Email, firstname, lastname, schoolLocation, and paymentPlan are required',
      });
    }

    // Only the two monthly plans can be bought. The school plan comes from a
    // school code and is never charged.
    if (paymentPlan !== 'LOCAL_MONTHLY' && paymentPlan !== 'GLOBAL_MONTHLY') {
      return res.status(400).json({
        ok: false,
        message: 'Choose the Local or Global monthly plan.',
      });
    }

    const ip = getClientIp(req) || '127.0.0.1';
    const result = await initializeMonthlySubscription(
      email,
      firstname,
      lastname,
      schoolLocation,
      paymentPlan as PaymentPlan,
      ip
    );
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

// This function handles Paystack webhook verification and processes subscription payment events
//  and retries failed charges with another card by calling handleChargeFailed
// this function works
// export const verifyWebhook = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const secret = process.env.PAYSTACK_SECRET_KEY || '';
//     const hash = createHmac('sha512', secret)
//       .update(JSON.stringify(req.body))
//       .digest('hex');

//     if (hash !== req.headers['x-paystack-signature']) {
//       return res
//         .status(401)
//         .json({ ok: false, message: 'Invalid webhook signature' });
//     }

//     const event = req.body;
//     if (['charge.success', 'charge.failed'].includes(event.event)) {
//       const result = await verifySubscriptionPaymentService(
//         event.data.reference,
//         event.event
//       );

//       // For charge.failed, attempt to retry with another card
//       if (event.event === 'charge.failed') {
//         await handleChargeFailed(event.data.reference);
//       }

//       return res.status(result.status).json(result);
//     }

//     res.status(200).json({ ok: true, message: 'Webhook received' });
//   } catch (error) {
//     next(error);
//   }
// };
// this function above works // use it when the immediate one below fails to work

export const verifyWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      console.error('PAYSTACK_SECRET_KEY is not set');
      return res
        .status(500)
        .json({ ok: false, message: 'Server configuration error' });
    }
    const hash = createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res
        .status(401)
        .json({ ok: false, message: 'Invalid webhook signature' });
    }

    const event = req.body;

    // Add Direct Debit handling
    if (event.event === 'direct_debit.authorization.created') {
      const result = await verifyDirectDebitService(
        event.data.reference,
        event.event,
        event.data
      );
      return res.status(result.status).json(result);
    }

    // Existing payment handling
    if (['charge.success', 'charge.failed'].includes(event.event)) {
      const result = await verifySubscriptionPaymentService(
        event.data.reference,
        event.event
      );

      if (event.event === 'charge.failed') {
        await handleChargeFailed(event.data.reference);
      }

      return res.status(result.status).json(result);
    }

    res.status(200).json({ ok: true, message: 'Webhook received' });
  } catch (error) {
    next(error);
  }
};

// This function handles Paystack webhook verification and processes subscription payment events
// export const verifyWebhook = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const secret = process.env.PAYSTACK_SECRET_KEY || '';
//     const hash = createHmac('sha512', secret)
//       .update(JSON.stringify(req.body))
//       .digest('hex');

//     if (hash !== req.headers['x-paystack-signature']) {
//       return res
//         .status(401)
//         .json({ ok: false, message: 'Invalid webhook signature' });
//     }

//     const event = req.body;
//     if (['charge.success', 'charge.failed'].includes(event.event)) {
//       const result = await verifySubscriptionPaymentService(
//         event.data.reference,
//         event.event
//       );
//       return res.status(result.status).json(result);
//     }

//     res.status(200).json({ ok: true, message: 'Webhook received' });
//   } catch (error) {
//     next(error);
//   }
// };

export const cancelSubscription = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any)?.user?.id ?? '';
    const result = await cancelUserSubscription(userId);
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const getCards = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any)?.user?.id ?? '';
    const result = await getUserCards(userId);
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const deleteCard = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any)?.user?.id ?? '';
    const { authorization_code } = req.params;

    if (!authorization_code) {
      return res
        .status(400)
        .json({ ok: false, message: 'authorization_code is required' });
    }

    const result = await removeCard(userId, authorization_code);
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const addCardController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: 'email is required',
      });
    }

    const ip = getClientIp(req) || '127.0.0.1';
    const userId = (req as any)?.user?.id ?? '';
    console.log(userId);

    const result = await addCardToSubscription(userId, email, ip);

    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

export const addDirectDebitController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: 'email is required',
      });
    }

    const ip = getClientIp(req) || '127.0.0.1';
    const userId = (req as any)?.user?.id ?? '';
    console.log(userId);
    const result = await addDirectDebitToSubscription(userId, email, ip);

    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

// export const deactivateDirectDebitController = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const { authorization_code } = req.body;

//     if (!authorization_code) {
//       return res.status(400).json({
//         ok: false,
//         message: 'authorization_code is required',
//       });
//     }

//     const params = JSON.stringify({
//       authorization_code,
//     });

//     const options = {
//       hostname: 'api.paystack.co',
//       port: 443,
//       path: '/customer/authorization/deactivate',
//       method: 'POST',
//       headers: {
//         Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
//         'Content-Type': 'application/json',
//       },
//     };

//     const deactivatePromise = new Promise((resolve, reject) => {
//       const req = https.request(options, (res) => {
//         let data = '';
//         res.on('data', (chunk) => (data += chunk));
//         res.on('end', () => {
//           const response = JSON.parse(data);
//           if (res.statusCode === 200 && response.status) {
//             resolve(response);
//           } else {
//             reject(new Error(`Deactivation failed: ${data}`));
//           }
//         });
//       }).on('error', (error) => reject(error));

//       req.write(params);
//       req.end();
//     });

//     const result = await deactivatePromise;

//     res.status(200).json({
//       ok: true,
//       message: 'Direct Debit deactivated successfully',
//       data: result,
//     });
//   } catch (error: any) {
//     console.error('Error deactivating direct debit:', error);
//     res.status(500).json({
//       ok: false,
//       message: 'Failed to deactivate direct debit',
//       error: error.message,
//     });
//   }
// };

// test

// export const verifyWebhook = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     console.log('1: Webhook received:', JSON.stringify(req.body, null, 2));

//     // Verify webhook signature
//     const secret = process.env.PAYSTACK_SECRET_KEY || '';
//     const hash = createHmac('sha512', secret)
//       .update(JSON.stringify(req.body))
//       .digest('hex');

//     if (hash !== req.headers['x-paystack-signature']) {
//       console.error('2: Invalid webhook signature');
//       return res
//         .status(401)
//         .json({ ok: false, message: 'Invalid webhook signature' });
//     }

//     console.log('3: Webhook signature verified');
//     const event = req.body;

//     // Handle Direct Debit authorization events
//     if (event.event === 'direct_debit.authorization.created') {
//       console.log('4: Processing Direct Debit authorization event');
//       const result = await verifySubscriptionPaymentService(
//         event.data.reference,
//         event.event,
//         event.data
//       );
//       return res.status(result.status).json(result);
//     }

//     // Handle payment success/failure events
//     if (['charge.success', 'charge.failed'].includes(event.event)) {
//       console.log(`5: Processing ${event.event} event`);
//       const result = await verifySubscriptionPaymentService(
//         event.data.reference,
//         event.event
//       );
//       return res.status(result.status).json(result);
//     }

//     console.log('6: Webhook event not processed (not a payment event)');
//     res
//       .status(200)
//       .json({ ok: true, message: 'Webhook received but no action taken' });
//   } catch (error) {
//     console.error('7: Webhook processing error:', error);
//     next(error);
//   }
// };
