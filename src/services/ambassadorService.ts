/*
  Ambassadors are students with extra tools: an "AlignTraits" tag in Community,
  their own invite link, a few invite emails a day, and event drafts that an
  admin approves before students see them.

  To keep referrals honest, a referral only counts as "active" once the student
  has verified their email and finished the career survey. Ambassadors see
  totals only, never who joined or who paid.
*/
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { fail, ok } from './communityRules';
import { inviteBudgetLeft, noteInviteEmail, sendNotice, siteUrl } from './rolesMail';
import { presentEvent } from './communityService';
import { parseEventInput } from './communityAdminService';

type AnyUser = { id: string; role: string; email: string; firstname: string; lastname: string; createdAt?: Date };

const DAY = 24 * 60 * 60 * 1000;
export const AMBASSADOR_EMAILS_PER_DAY = Math.max(0, Number(process.env.AMBASSADOR_EMAILS_PER_DAY ?? 5) || 0);
const REFERRAL_WINDOW_DAYS = 14; // an account can be credited to an ambassador up to this many days after it was made
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Ambassadors never set the status of an event: drafts stay drafts until an admin approves. */
const withoutStatus = (input: Record<string, unknown>) => {
  const { status: _ignored, ...rest } = input || {};
  return rest;
};
const cleanEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isEmail = (v: string) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function newCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export async function createAmbassadorProfile(userId: string, createdById: string | null) {
  await ensureRolesTables();
  const existing = await db.ambassadorProfile.findUnique({ where: { userId } });
  if (existing) {
    if (!existing.active) await db.ambassadorProfile.update({ where: { userId }, data: { active: true } });
    return existing;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.ambassadorProfile.create({ data: { userId, code: newCode(), createdById } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const again = await db.ambassadorProfile.findUnique({ where: { userId } });
        if (again) return again;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not make an ambassador code');
}

export async function activeAmbassador(userId: string) {
  const p = await db.ambassadorProfile.findUnique({ where: { userId } });
  return p && p.active ? p : null;
}

/* ----------------------------- Stats ----------------------------- */

async function statsFor(ambassadorId: string) {
  const referrals = await db.ambassadorReferral.findMany({ where: { ambassadorId }, select: { userId: true, createdAt: true } });
  const ids = referrals.map((r) => r.userId);
  const active = ids.length
    ? await db.user.count({ where: { id: { in: ids }, emailVerified: { not: null }, careerResults: { isNot: null } } })
    : 0;
  const invites = await db.ambassadorInvite.count({ where: { ambassadorId } });
  // Growth: joins per week for the last 8 weeks, oldest first.
  const now = Date.now();
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = now - (7 - i) * 7 * DAY;
    const start = end - 7 * DAY;
    return {
      weekStart: new Date(start),
      joined: referrals.filter((r) => r.createdAt.getTime() > start && r.createdAt.getTime() <= end).length,
    };
  });
  return { invitesSent: invites, joined: referrals.length, activeStudents: active, weeks };
}

/* ----------------------------- The ambassador ----------------------------- */

export async function myAmbassadorService(user: AnyUser) {
  await ensureRolesTables();
  const profile = await activeAmbassador(user.id);
  if (!profile) return fail(404, 'You are not an ambassador.', { code: 'NOT_AMBASSADOR' });
  const sentToday = await db.ambassadorInvite.count({ where: { ambassadorId: user.id, createdAt: { gt: new Date(Date.now() - DAY) } } });
  const link = `${siteUrl()}/signup?ref=${profile.code}`;
  return ok({
    code: profile.code,
    link,
    whatsappText: `I use AlignTraits to see which courses and universities I can realistically get into, and what they cost. Check yours here: ${link}`,
    emailsLeftToday: Math.max(0, AMBASSADOR_EMAILS_PER_DAY - sentToday),
    emailsPerDay: AMBASSADOR_EMAILS_PER_DAY,
    since: profile.createdAt,
    stats: await statsFor(user.id),
  });
}

export async function ambassadorInviteService(user: AnyUser, rawEmail: unknown) {
  await ensureRolesTables();
  const profile = await activeAmbassador(user.id);
  if (!profile) return fail(403, 'Only ambassadors can send invites.');
  const email = cleanEmail(rawEmail);
  if (!isEmail(email)) return fail(400, 'Enter a valid email address.');
  if (email === cleanEmail(user.email)) return fail(400, 'You cannot invite yourself.');

  const sentToday = await db.ambassadorInvite.count({ where: { ambassadorId: user.id, createdAt: { gt: new Date(Date.now() - DAY) } } });
  if (sentToday >= AMBASSADOR_EMAILS_PER_DAY) {
    return fail(429, `You have used today's ${AMBASSADOR_EMAILS_PER_DAY} invite emails. Share your link on WhatsApp instead, or send more tomorrow.`, { code: 'DAILY_LIMIT' });
  }
  if (inviteBudgetLeft() <= 0) {
    return fail(429, 'Invite emails are paused for today. Share your link on WhatsApp instead.', { code: 'SITE_LIMIT' });
  }
  const existing = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
  if (existing) return fail(409, 'This person already has an AlignTraits account.', { code: 'HAS_ACCOUNT' });
  const already = await db.ambassadorInvite.findUnique({ where: { email } });
  if (already) return fail(409, 'This email has already been invited. Each address is only invited once.', { code: 'ALREADY_INVITED' });

  try {
    await db.ambassadorInvite.create({ data: { ambassadorId: user.id, email } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return fail(409, 'This email has already been invited. Each address is only invited once.', { code: 'ALREADY_INVITED' });
    }
    throw error;
  }
  const link = `${siteUrl()}/signup?ref=${profile.code}`;
  const sent = await sendNotice({
    to: email,
    subject: `${user.firstname} invited you to AlignTraits`,
    name: 'there',
    label: 'Invitation',
    headline: 'See which courses you can realistically get into',
    lines: [
      `${user.firstname}, an AlignTraits ambassador, thinks AlignTraits could help you.`,
      'AlignTraits shows the courses and universities that match your results, what they cost, and how your score compares with last year’s cut-off marks.',
    ],
    ctaUrl: link,
    ctaLabel: 'Create my free account',
    footer: 'You are getting this one email because a student entered your address. We will not email you again unless you sign up.',
  });
  if (sent) noteInviteEmail();
  return ok(
    { email, emailsLeftToday: Math.max(0, AMBASSADOR_EMAILS_PER_DAY - sentToday - 1) },
    sent ? `Invite sent to ${email}` : 'Invite saved, but the email could not be sent right now.',
    201
  );
}

/** After sign-up: credits a new account to the ambassador whose link was used. */
export async function claimReferralService(user: AnyUser, rawCode: unknown) {
  await ensureRolesTables();
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return fail(400, 'Invite code not recognised.');
  if (user.role !== 'USER') return ok({ credited: false });
  const profile = await db.ambassadorProfile.findUnique({ where: { code } });
  if (!profile || !profile.active || profile.userId === user.id) return ok({ credited: false });
  const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
  // Only new accounts count. Older accounts cannot be claimed by anyone.
  if (!created || Date.now() - created > REFERRAL_WINDOW_DAYS * DAY) return ok({ credited: false });
  // Someone who referred this ambassador cannot be credited back (no swapping).
  const reverse = await db.ambassadorReferral.findFirst({ where: { ambassadorId: user.id, userId: profile.userId } });
  if (reverse) return ok({ credited: false });
  try {
    await db.ambassadorReferral.create({ data: { ambassadorId: profile.userId, userId: user.id } });
    return ok({ credited: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return ok({ credited: false });
    throw error;
  }
}

/* ----------------------------- Event drafts ----------------------------- */

export async function myEventDraftsService(user: AnyUser) {
  await ensureRolesTables();
  if (!(await activeAmbassador(user.id))) return fail(403, 'Only ambassadors can suggest events.');
  const rows = await db.communityEvent.findMany({
    where: { createdById: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return ok(rows.map((r) => presentEvent(r as any)));
}

export async function createEventDraftService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  if (!(await activeAmbassador(user.id))) return fail(403, 'Only ambassadors can suggest events.');
  const pending = await db.communityEvent.count({ where: { createdById: user.id, status: 'DRAFT' } });
  if (pending >= 5) return fail(429, 'You have 5 events waiting for approval. Wait for the team to review them first.');
  const parsed = parseEventInput(withoutStatus(input), false);
  if (!parsed.data) return fail(400, parsed.error || 'Check the event details.');
  const d = parsed.data as any;
  if (d.endsAt && d.endsAt <= d.startsAt) return fail(400, 'The end time must be after the start time.');
  if (d.startsAt.getTime() < Date.now()) return fail(400, 'Pick a date in the future.');
  if (d.kind === 'EXAM' || d.kind === 'DEADLINE') return fail(400, 'Exam dates and deadlines are added by the AlignTraits team.');
  const row = await db.communityEvent.create({
    data: { ...d, status: 'DRAFT', createdById: user.id, hostName: d.hostName || `${user.firstname} ${user.lastname[0] || ''}.`.trim() },
  });
  return ok(presentEvent(row as any), 'Sent for approval. You will see it in Events once the team approves it.', 201);
}

export async function updateEventDraftService(user: AnyUser, id: string, input: Record<string, unknown>) {
  await ensureRolesTables();
  if (!(await activeAmbassador(user.id))) return fail(403, 'Only ambassadors can suggest events.');
  const row = await db.communityEvent.findFirst({ where: { id, createdById: user.id } });
  if (!row) return fail(404, 'Event not found.');
  if (row.status !== 'DRAFT') return fail(409, 'This event has been approved, so only the team can change it now.');
  const parsed = parseEventInput(withoutStatus(input), true);
  if (!parsed.data) return fail(400, parsed.error || 'Check the event details.');
  const d = parsed.data as any;
  if (d.kind === 'EXAM' || d.kind === 'DEADLINE') return fail(400, 'Exam dates and deadlines are added by the AlignTraits team.');
  const startsAt = d.startsAt ?? row.startsAt;
  const endsAt = d.endsAt !== undefined ? d.endsAt : row.endsAt;
  if (endsAt && endsAt <= startsAt) return fail(400, 'The end time must be after the start time.');
  const updated = await db.communityEvent.update({ where: { id }, data: d });
  return ok(presentEvent(updated as any), 'Draft saved');
}

export async function deleteEventDraftService(user: AnyUser, id: string) {
  await ensureRolesTables();
  const row = await db.communityEvent.findFirst({ where: { id, createdById: user.id, status: 'DRAFT' } });
  if (!row) return fail(404, 'Draft not found.');
  await db.communityEvent.delete({ where: { id } });
  return ok({ id }, 'Draft deleted');
}

/* ----------------------------- Admin ----------------------------- */

export async function adminListAmbassadorsService() {
  await ensureRolesTables();
  const rows = await db.ambassadorProfile.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { user: { select: { id: true, firstname: true, lastname: true, email: true } } },
  });
  const data = await Promise.all(
    rows.map(async (r) => ({
      id: r.userId,
      name: `${r.user.firstname} ${r.user.lastname}`.trim(),
      email: r.user.email,
      code: r.code,
      active: r.active,
      since: r.createdAt,
      ...(await statsFor(r.userId)),
    }))
  );
  return ok(data);
}

export async function adminSetAmbassadorActiveService(userId: string, active: unknown) {
  await ensureRolesTables();
  if (typeof active !== 'boolean') return fail(400, 'Send active as true or false.');
  const row = await db.ambassadorProfile.findUnique({ where: { userId } });
  if (!row) return fail(404, 'Ambassador not found.');
  await db.ambassadorProfile.update({ where: { userId }, data: { active } });
  return ok({ id: userId, active }, active ? 'Ambassador switched back on' : 'Ambassador paused. Their tag and tools are hidden until you switch them back on.');
}

/** Students who already have an account can be made ambassadors directly. */
export async function adminMakeAmbassadorService(admin: AnyUser, rawEmail: unknown) {
  await ensureRolesTables();
  const email = cleanEmail(rawEmail);
  if (!isEmail(email)) return fail(400, 'Enter a valid email address.');
  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (!user) return fail(404, 'No student account uses this email. Send an invitation instead.', { code: 'NO_ACCOUNT' });
  if (user.role !== 'USER') return fail(409, 'This email belongs to a staff account. Ambassadors are students.');
  const profile = await createAmbassadorProfile(user.id, admin.id);
  await sendNotice({
    to: user.email,
    subject: 'You are now an AlignTraits ambassador',
    name: user.firstname || 'there',
    label: 'Ambassador',
    headline: 'Welcome, ambassador',
    lines: [
      'You now have an AlignTraits tag in Community and your own invite link to bring other students in.',
      'Sign in and open Ambassador in your menu to see your link and how many students have joined through you.',
    ],
    ctaUrl: `${siteUrl()}/dashboard/ambassador`,
    ctaLabel: 'Open my ambassador page',
  });
  return ok({ id: user.id, code: profile.code }, `${user.firstname || 'The student'} is now an ambassador`);
}
