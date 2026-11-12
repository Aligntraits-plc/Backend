/*
  Invitations. A super admin (or, for counsellors and ambassadors, an admin)
  enters an email address and a role. The person gets a link, sets their own
  name and password, and is onboarded. No password is ever chosen for them or
  sent by email. Only a hash of the link's token is stored.
*/
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { fail, ok } from './communityRules';
import { INVITABLE_STAFF, isAdmin, isPanelStaff, isSuperAdmin, roleLabel } from './roles';
import { sendNotice, siteUrl } from './rolesMail';
import { createAmbassadorProfile } from './ambassadorService';
import { joinSchoolChannel } from './partnerSchoolService';

type Actor = { id: string; role: string; firstname?: string | null };

const INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const ROLES = [...INVITABLE_STAFF, 'COUNSELLOR', 'AMBASSADOR'] as const;

const cleanEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isEmail = (v: string) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const findUserByEmail = (email: string) =>
  db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

const mayInvite = (actor: Actor, role: string) =>
  role === 'COUNSELLOR' || role === 'AMBASSADOR' ? isAdmin(actor) : isSuperAdmin(actor);

type InviteRow = {
  id: string;
  email: string;
  role: string;
  partnerSchoolId: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

const statusOf = (r: InviteRow) =>
  r.acceptedAt ? 'accepted' : r.revokedAt ? 'cancelled' : r.expiresAt.getTime() <= Date.now() ? 'expired' : 'pending';

function present(r: InviteRow, schoolName?: string | null) {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    roleLabel: roleLabel(r.role),
    schoolId: r.partnerSchoolId,
    schoolName: schoolName ?? null,
    status: statusOf(r),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
  };
}

async function sendInviteEmail(row: InviteRow, token: string, schoolName: string | null, actor: Actor) {
  const link = `${siteUrl()}/invite/${token}`;
  const what =
    row.role === 'COUNSELLOR'
      ? `the AlignTraits school portal for ${schoolName}`
      : row.role === 'AMBASSADOR'
        ? 'AlignTraits as an ambassador'
        : `the AlignTraits team as ${roleLabel(row.role).toLowerCase()}`;
  const lines =
    row.role === 'AMBASSADOR'
      ? [
          `${actor.firstname || 'The AlignTraits team'} has invited you to become an AlignTraits ambassador.`,
          'As an ambassador you keep everything you have as a student, and you also get an ambassador tag in Community and your own invite link to bring other students in.',
          'Open the link below to accept. If you do not have an AlignTraits account yet, you will set one up there.',
        ]
      : [
          `${actor.firstname || 'The AlignTraits team'} has invited you to join ${what}.`,
          'Open the link below to set your name and password. After that you can sign in.',
        ];
  return sendNotice({
    to: row.email,
    subject: row.role === 'AMBASSADOR' ? 'You are invited to be an AlignTraits ambassador' : `Your invitation to ${what}`,
    name: 'there',
    label: 'Invitation',
    headline: row.role === 'AMBASSADOR' ? 'Become an AlignTraits ambassador' : `Join ${what}`,
    lines,
    details: [{ label: 'This link works until', value: row.expiresAt.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' }) }],
    ctaUrl: link,
    ctaLabel: 'Accept invitation',
    footer: 'If you were not expecting this, you can ignore this email. Nothing happens until the link is opened.',
  });
}

/* ----------------------------- Admin side ----------------------------- */

export async function createInviteService(actor: Actor, input: Record<string, unknown>) {
  await ensureRolesTables();
  const email = cleanEmail(input?.email);
  const role = String(input?.role || '');
  if (!isEmail(email)) return fail(400, 'Enter a valid email address.');
  if (!(ROLES as readonly string[]).includes(role)) return fail(400, 'Pick a role for this person.');
  if (!mayInvite(actor, role)) return fail(403, 'Only a super admin can invite staff.');

  let school: { id: string; name: string } | null = null;
  if (role === 'COUNSELLOR') {
    const schoolId = typeof input?.partnerSchoolId === 'string' ? input.partnerSchoolId : '';
    school = schoolId ? await db.partnerSchool.findUnique({ where: { id: schoolId }, select: { id: true, name: true } }) : null;
    if (!school) return fail(400, 'Pick the partner school this counsellor works at.');
  }

  const existing = await findUserByEmail(email);
  if (role === 'AMBASSADOR') {
    if (existing && existing.role !== 'USER') return fail(409, 'This email belongs to a staff account. Ambassadors are students.');
    if (existing) {
      const profile = await db.ambassadorProfile.findUnique({ where: { userId: existing.id } });
      if (profile) return fail(409, profile.active ? 'This student is already an ambassador.' : 'This student is a paused ambassador. Switch them back on in the ambassador list.');
    }
  } else if (existing) {
    if (existing.role === 'USER') return fail(409, 'This email already has a student account. Use a different email address for the staff account.');
    return fail(409, `This email already has an account (${roleLabel(existing.role)}). ${isPanelStaff(existing) ? 'Change their role in the team list.' : ''}`.trim());
  }

  // One live invitation per address: a new one replaces any older one.
  await db.roleInvite.updateMany({
    where: { email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const token = newToken();
  const row = await db.roleInvite.create({
    data: {
      email,
      role,
      partnerSchoolId: school?.id ?? null,
      tokenHash: hashToken(token),
      invitedById: actor.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * DAY),
    },
  });
  const sent = await sendInviteEmail(row, token, school?.name ?? null, actor);
  return ok(
    { ...present(row, school?.name), emailSent: sent },
    sent ? `Invitation sent to ${email}` : `Invitation saved, but the email could not be sent. Use "Send again" in a moment.`,
    201
  );
}

export async function listInvitesService(actor: Actor) {
  await ensureRolesTables();
  const rows = await db.roleInvite.findMany({
    where: isSuperAdmin(actor) ? {} : { role: { in: ['COUNSELLOR', 'AMBASSADOR'] } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const schoolIds = Array.from(new Set(rows.map((r) => r.partnerSchoolId).filter(Boolean))) as string[];
  const schools = schoolIds.length
    ? await db.partnerSchool.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(schools.map((s) => [s.id, s.name]));
  return ok(rows.map((r) => present(r, r.partnerSchoolId ? nameOf.get(r.partnerSchoolId) : null)));
}

async function ownInvite(actor: Actor, id: string) {
  const row = await db.roleInvite.findUnique({ where: { id } });
  if (!row || !mayInvite(actor, row.role)) return null;
  return row;
}

export async function revokeInviteService(actor: Actor, id: string) {
  await ensureRolesTables();
  const row = await ownInvite(actor, id);
  if (!row) return fail(404, 'Invitation not found.');
  if (row.acceptedAt) return fail(409, 'This invitation was already accepted.');
  const updated = await db.roleInvite.update({ where: { id }, data: { revokedAt: row.revokedAt ?? new Date() } });
  return ok(present(updated), 'Invitation cancelled');
}

export async function resendInviteService(actor: Actor, id: string) {
  await ensureRolesTables();
  const row = await ownInvite(actor, id);
  if (!row) return fail(404, 'Invitation not found.');
  if (row.acceptedAt) return fail(409, 'This invitation was already accepted.');
  const token = newToken();
  const updated = await db.roleInvite.update({
    where: { id },
    data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * DAY), revokedAt: null },
  });
  const school = updated.partnerSchoolId
    ? await db.partnerSchool.findUnique({ where: { id: updated.partnerSchoolId }, select: { name: true } })
    : null;
  const sent = await sendInviteEmail(updated, token, school?.name ?? null, actor);
  if (!sent) return fail(502, 'The email could not be sent. Please try again in a moment.');
  return ok(present(updated, school?.name), `Invitation sent again to ${updated.email}`);
}

/* ----------------------------- The invited person ----------------------------- */

async function liveInvite(token: unknown) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.roleInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

const GONE = 'This invitation link is no longer valid. Ask the person who invited you to send a new one.';

export async function readInviteService(token: unknown) {
  await ensureRolesTables();
  const row = await liveInvite(token);
  if (!row) return fail(404, GONE, { code: 'INVITE_GONE' });
  const [school, user] = await Promise.all([
    row.partnerSchoolId ? db.partnerSchool.findUnique({ where: { id: row.partnerSchoolId }, select: { name: true } }) : null,
    findUserByEmail(row.email),
  ]);
  return ok({
    email: row.email,
    role: row.role,
    roleLabel: roleLabel(row.role),
    schoolName: school?.name ?? null,
    // An ambassador who already has a password just confirms; everyone else sets one.
    needsPassword: !user || !user.password,
    firstname: user?.firstname && user.firstname !== 'Student' ? user.firstname : '',
    lastname: user?.lastname && user.lastname !== 'AlignTraits' ? user.lastname : '',
  });
}

const nameOk = (v: unknown) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60;
const strongPassword = (p: unknown): p is string =>
  typeof p === 'string' && p.length >= 8 && p.length <= 100 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);

export async function acceptInviteService(token: unknown, body: Record<string, unknown>) {
  await ensureRolesTables();
  const row = await liveInvite(token);
  if (!row) return fail(404, GONE, { code: 'INVITE_GONE' });

  const existing = await findUserByEmail(row.email);
  const needsPassword = !existing || !existing.password;

  if (row.role !== 'AMBASSADOR' && existing) {
    return fail(409, 'This email already has an AlignTraits account. Ask the person who invited you to use a different email.');
  }
  if (row.role === 'AMBASSADOR' && existing && existing.role !== 'USER') {
    return fail(409, 'This email belongs to a staff account. Ambassadors are students.');
  }
  if (needsPassword) {
    if (!nameOk(body?.firstname) || !nameOk(body?.lastname)) return fail(400, 'Enter your first name and last name.');
    if (!strongPassword(body?.password)) {
      return fail(400, 'Use a password of at least 8 characters with a capital letter, a small letter, a number and a symbol.');
    }
  }
  const names = needsPassword
    ? { firstname: String(body.firstname).trim(), lastname: String(body.lastname).trim() }
    : {};
  const password = needsPassword ? await bcrypt.hash(String(body.password), 10) : undefined;

  // Claim the invitation first, so a link can never be used twice.
  const claimed = await db.roleInvite.updateMany({
    where: { id: row.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (claimed.count === 0) return fail(404, GONE, { code: 'INVITE_GONE' });

  try {
    if (row.role === 'AMBASSADOR') {
      const user = existing
        ? needsPassword
          ? await db.user.update({ where: { id: existing.id }, data: { ...names, password, emailVerified: existing.emailVerified ?? new Date() } })
          : existing
        : await db.user.create({
            data: { ...(names as { firstname: string; lastname: string }), email: row.email, password: password!, role: 'USER', emailVerified: new Date() },
          });
      await createAmbassadorProfile(user.id, row.invitedById);
      return ok({ role: 'AMBASSADOR', email: user.email, login: '/login' }, 'You are now an AlignTraits ambassador. Sign in to see your invite link.');
    }

    const user = await db.user.create({
      data: {
        ...(names as { firstname: string; lastname: string }),
        email: row.email,
        password: password!,
        role: row.role as any,
        emailVerified: new Date(), // they opened the link we emailed
      },
    });
    if (row.role === 'COUNSELLOR' && row.partnerSchoolId) {
      await db.partnerSchoolStaff.create({ data: { schoolId: row.partnerSchoolId, userId: user.id } });
      await joinSchoolChannel(user.id, row.partnerSchoolId); // also makes the channel if it is missing
    }
    return ok({ role: row.role, email: user.email, login: '/admin/login' }, 'Your account is ready. Sign in to continue.');
  } catch (error) {
    // Give the link back if the account could not be made.
    await db.roleInvite.update({ where: { id: row.id }, data: { acceptedAt: null } }).catch(() => undefined);
    throw error;
  }
}
