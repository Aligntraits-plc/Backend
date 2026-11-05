// School codes: a partner school gives its students a code, and the code opens
// the School partner plan (every AlignTraits feature, no payment) until the code
// expires. Each code works for a limited number of students.
import crypto from 'crypto';
import { Prisma, PaymentPlan, Roles, TransactionStatus } from '@prisma/client';
import { db } from '../config/db';
import { createUser, getUserByEmail } from '../models/userModel';
import { ensureSchoolCodeTables } from './schoolCodeTables';

// No 0, O, 1, I or L, so codes are easy to read out and type.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_VALID_DAYS = 30;
export const DEFAULT_SEATS = 20;
const MAX_SEATS = 500;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Wrong guesses: 5 per student (or email) per hour, and a ceiling for the whole
// site so nobody can try codes at scale. Kept in memory: a restart only gives a
// few more tries, never access.
const TRIES_PER_PERSON = 5;
const SITE_WIDE_WRONG_PER_HOUR = 300;
const wrongByPerson = new Map<string, number[]>();
let wrongSiteWide: number[] = [];

const recent = (times: number[] = []) => times.filter((t) => Date.now() - t < HOUR);

function wrongTriesLeft(person: string) {
  return Math.max(0, TRIES_PER_PERSON - recent(wrongByPerson.get(person)).length);
}

function noteWrongTry(person: string) {
  const now = Date.now();
  wrongByPerson.set(person, [...recent(wrongByPerson.get(person)), now]);
  wrongSiteWide = [...recent(wrongSiteWide), now];
  if (wrongByPerson.size > 5000) {
    for (const [key, times] of wrongByPerson) {
      if (recent(times).length === 0) wrongByPerson.delete(key);
    }
  }
}

export const normaliseCode = (value: unknown) =>
  typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';

const WELL_FORMED = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

type CodeRow = {
  id: string;
  code: string;
  schoolName: string;
  seats: number;
  used: number;
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
};

function present(row: CodeRow) {
  const now = Date.now();
  const expired = row.expiresAt.getTime() <= now;
  const status = !row.active
    ? 'off'
    : expired
      ? 'expired'
      : row.used >= row.seats
        ? 'full'
        : 'active';
  return {
    id: row.id,
    code: row.code,
    schoolName: row.schoolName,
    seats: row.seats,
    used: row.used,
    active: row.active,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status,
    daysLeft: expired ? 0 : Math.ceil((row.expiresAt.getTime() - now) / DAY),
  };
}

const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  status,
  message,
  errors: [{ message }],
  ...extra,
});

/* ----------------------------- Admin ----------------------------- */

export async function createSchoolCodeService({
  schoolName,
  seats,
  adminId,
}: {
  schoolName: unknown;
  seats?: unknown;
  adminId: string;
}) {
  const name = typeof schoolName === 'string' ? schoolName.trim() : '';
  if (name.length < 2 || name.length > 120) {
    return fail(400, 'Enter the school name (2 to 120 characters).');
  }
  const seatCount = seats === undefined || seats === null || seats === '' ? DEFAULT_SEATS : Number(seats);
  if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > MAX_SEATS) {
    return fail(400, `Seats must be a whole number from 1 to ${MAX_SEATS}.`);
  }

  await ensureSchoolCodeTables();
  const expiresAt = new Date(Date.now() + CODE_VALID_DAYS * DAY);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await db.schoolCode.create({
        data: {
          code: generateCode(),
          schoolName: name,
          seats: seatCount,
          createdById: adminId || null,
          expiresAt,
        },
      });
      return { ok: true, status: 201, message: 'School code created', data: present(row) };
    } catch (error) {
      // Two codes came out the same (very unlikely): try a new one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  return fail(500, 'Could not create a unique code. Please try again.');
}

export async function listSchoolCodesService() {
  await ensureSchoolCodeTables();
  const rows = await db.schoolCode.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return { ok: true, status: 200, message: 'School codes', data: rows.map(present) };
}

export async function setSchoolCodeActiveService(id: string, active: unknown) {
  if (typeof active !== 'boolean') return fail(400, 'Send active as true or false.');
  await ensureSchoolCodeTables();
  const row = await db.schoolCode.findUnique({ where: { id } });
  if (!row) return fail(404, 'School code not found.');
  const updated = await db.schoolCode.update({ where: { id }, data: { active } });
  return {
    ok: true,
    status: 200,
    // Switching a code off stops new students from using it. Students who already
    // used it keep access until the code's end date.
    message: active ? 'School code switched on' : 'School code switched off',
    data: present(updated),
  };
}

/* ---------------------------- Students ---------------------------- */

type Account = { id: string; email: string; password: string; payment_plan: PaymentPlan | null; payment_plan_expires_at: Date | null };

class SeatsFullError extends Error {}

export async function redeemSchoolCodeService({
  code: rawCode,
  user,
  visitor,
}: {
  code: unknown;
  user?: Account | null;
  visitor?: { email?: unknown; firstname?: unknown; lastname?: unknown };
}) {
  const visitorEmail = typeof visitor?.email === 'string' ? visitor.email.trim() : '';
  if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitorEmail)) {
    return fail(400, 'Log in, or go back and enter your email, to use a school code.');
  }
  const person = user ? `u:${user.id}` : `e:${visitorEmail.toLowerCase()}`;

  if (recent(wrongSiteWide).length >= SITE_WIDE_WRONG_PER_HOUR) {
    return fail(429, 'Too many attempts right now. Please try again in a few minutes.', { code: 'TOO_MANY' });
  }
  if (wrongTriesLeft(person) === 0) {
    return fail(429, 'Too many wrong codes. Please try again in an hour, or ask your school to check the code.', { code: 'TOO_MANY' });
  }

  const code = normaliseCode(rawCode);
  if (!WELL_FORMED.test(code)) {
    return fail(400, 'School codes are 6 letters and numbers, like K7Q2PX.', { code: 'BAD_FORMAT' });
  }

  await ensureSchoolCodeTables();
  const row = await db.schoolCode.findUnique({ where: { code } });

  if (!row) {
    noteWrongTry(person);
    const left = wrongTriesLeft(person);
    return fail(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : "That code isn't right. Please try again in an hour.", {
      code: 'WRONG_CODE',
      triesLeft: left,
    });
  }
  if (!row.active) {
    return fail(400, 'This code has been switched off. Ask your school for a new one.', { code: 'CODE_OFF' });
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return fail(400, 'This code has expired. Ask your school for a new one.', { code: 'CODE_EXPIRED' });
  }

  // Whose account gets the plan. Visitors only reach this point with a real code,
  // so no accounts are made for wrong guesses.
  let account: Account | null = user ?? null;
  if (!account) {
    const existing = await getUserByEmail(visitorEmail);
    if (existing && existing.password) {
      return fail(409, 'This email already has an AlignTraits account. Log in to use your school code.', { code: 'LOGIN_REQUIRED' });
    }
    account =
      existing ??
      (await createUser({
        data: {
          firstname: (typeof visitor?.firstname === 'string' && visitor.firstname.trim()) || 'Student',
          lastname: (typeof visitor?.lastname === 'string' && visitor.lastname.trim()) || 'AlignTraits',
          email: visitorEmail,
          password: '',
          role: Roles.USER,
        },
      }));
  }

  const success = (message: string) => ({
    ok: true,
    status: 200,
    message,
    data: {
      schoolName: row.schoolName,
      expiresAt: row.expiresAt,
      needsPassword: !account!.password,
      email: account!.email,
    },
  });

  const already = await db.schoolCodeRedemption.findUnique({
    where: { codeId_userId: { codeId: row.id, userId: account.id } },
  });
  if (already) return success(`You're already covered by ${row.schoolName}.`);

  const now = Date.now();
  const planActive = account.payment_plan && (!account.payment_plan_expires_at || account.payment_plan_expires_at.getTime() > now);
  if (planActive && (account.payment_plan === 'LOCAL_MONTHLY' || account.payment_plan === 'GLOBAL_MONTHLY')) {
    const until = account.payment_plan_expires_at
      ? ` until ${account.payment_plan_expires_at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
      : '';
    return fail(409, `You already have a monthly plan${until}. You can use your school code after it ends.`, { code: 'ACTIVE_PLAN' });
  }
  if (planActive && account.payment_plan === 'SCHOOL_PARTNER') {
    return fail(409, 'You are already covered by a school code. You can use a new one after it ends.', { code: 'ALREADY_COVERED' });
  }

  try {
    await db.$transaction(async (tx) => {
      // Take a seat only if one is left, in one step, so two students can never
      // take the last seat at the same time.
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "school_codes" SET "used" = "used" + 1
        WHERE "id" = ${row.id} AND "active" = true AND "used" < "seats" AND "expiresAt" > NOW()
        RETURNING "id"`;
      if (claimed.length === 0) throw new SeatsFullError();

      await tx.schoolCodeRedemption.create({ data: { codeId: row.id, userId: account!.id } });
      await tx.user.update({
        where: { id: account!.id },
        data: { payment_plan: 'SCHOOL_PARTNER', payment_plan_expires_at: row.expiresAt },
      });
      // A ₦0 record so the plan shows in billing history and in payment checks.
      await tx.transaction.create({
        data: {
          userId: account!.id,
          paymentPlan: 'SCHOOL_PARTNER',
          amount: 0,
          currency: 'NGN',
          reference: `school_${row.code}_${account!.id}`,
          status: TransactionStatus.SUCCESS,
          schoolLocation: row.schoolName,
        },
      });
    });
  } catch (error) {
    if (error instanceof SeatsFullError) {
      return fail(409, `This code has reached its limit of ${row.seats} ${row.seats === 1 ? 'student' : 'students'}. Ask your school for a new code.`, { code: 'CODE_FULL' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // The same student pressed twice: the first request already covered them.
      return success(`You're already covered by ${row.schoolName}.`);
    }
    throw error;
  }

  wrongByPerson.delete(person);
  return success(`You're covered by ${row.schoolName}.`);
}

// For the student's own profile: which school covers them, and until when.
export async function getSchoolAccessForUser(userId: string) {
  const latest = await db.schoolCodeRedemption.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { code: true },
  });
  return latest ? { schoolName: latest.code.schoolName, expiresAt: latest.code.expiresAt } : null;
}
