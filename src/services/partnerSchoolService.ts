/*
  Partner schools (secondary schools that work with AlignTraits) and the school
  portal their counsellors use.

  The rule that matters most: a counsellor only ever sees students linked to
  their own school. Every portal function starts from the counsellor's school
  and filters by it here, on the server.
*/
import crypto from 'crypto';
import Paystack from 'paystack-api';
import { Prisma, Roles } from '@prisma/client';
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { displayName, fail, ok } from './communityRules';
import { applySchoolSeat, generateCode } from './schoolCodeService';
import { inviteBudgetLeft, noteInviteEmail, sendNotice, siteUrl } from './rolesMail';
import { studentInsights, topByTier, TIER_LABELS } from './studentInsights';

type AnyUser = { id: string; role: string; email: string; firstname: string; lastname: string };

const DAY = 24 * 60 * 60 * 1000;
export const SEAT_PRICE = Math.max(1, Number(process.env.SCHOOL_SEAT_PRICE ?? 2600) || 2600); // naira per student
export const SEAT_DAYS = Math.max(1, Number(process.env.SCHOOL_SEAT_DAYS ?? 30) || 30);
const MIN_SEATS = 1;
const MAX_SEATS = 500;
const SCHOOL_INVITES_PER_DAY = Math.max(0, Number(process.env.SCHOOL_INVITES_PER_DAY ?? 25) || 0);
const CLASS_LEVELS = ['SS1', 'SS2', 'SS3', 'Finished'];

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cleanEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isEmail = (v: string) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const findUserByEmail = (email: string) =>
  db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

/* ----------------------------- School channel ----------------------------- */

/** Every partner school has one private Community channel. Makes it if missing. */
export async function ensureSchoolChannel(schoolId: string) {
  const existing = await db.communityChannel.findUnique({ where: { partnerSchoolId: schoolId } });
  if (existing) return existing;
  const school = await db.partnerSchool.findUnique({ where: { id: schoolId } });
  if (!school) return null;
  const base = school.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'school';
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `${base}-${crypto.randomBytes(2).toString('hex')}`.slice(0, 60);
    try {
      return await db.communityChannel.create({
        data: {
          slug,
          name: school.name,
          description: `Private to ${school.name}. Only its students and counsellors can see this channel.`,
          welcome: `Welcome to the ${school.name} channel. Only students and counsellors of your school are here.`,
          position: 50,
          partnerSchoolId: school.id,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const again = await db.communityChannel.findUnique({ where: { partnerSchoolId: schoolId } });
        if (again) return again;
        continue;
      }
      throw error;
    }
  }
  return null;
}

/** The school a person belongs to, as a student or a counsellor (null for everyone else). */
export async function schoolIdOf(user: { id: string; role: string }): Promise<string | null> {
  if (user.role === 'COUNSELLOR') {
    const staff = await db.partnerSchoolStaff.findUnique({ where: { userId: user.id } });
    return staff?.schoolId ?? null;
  }
  const link = await db.partnerSchoolStudent.findUnique({ where: { userId: user.id } });
  return link && !link.removedAt ? link.schoolId : null;
}

/* ----------------------------- Admin ----------------------------- */

async function presentSchool(s: { id: string; name: string; state: string | null; contactEmail: string | null; active: boolean; createdAt: Date }) {
  const now = new Date();
  const [students, counsellors, codes] = await Promise.all([
    db.partnerSchoolStudent.count({ where: { schoolId: s.id, removedAt: null } }),
    db.partnerSchoolStaff.findMany({ where: { schoolId: s.id }, include: { user: { select: { firstname: true, lastname: true, email: true } } } }),
    db.schoolCode.findMany({ where: { partnerSchoolId: s.id, active: true, expiresAt: { gt: now } }, select: { seats: true, used: true } }),
  ]);
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    contactEmail: s.contactEmail,
    active: s.active,
    createdAt: s.createdAt,
    students,
    counsellors: counsellors.map((c) => ({ id: c.userId, name: `${c.user.firstname} ${c.user.lastname}`.trim(), email: c.user.email })),
    seats: codes.reduce((a, c) => a + c.seats, 0),
    seatsUsed: codes.reduce((a, c) => a + c.used, 0),
  };
}

export async function adminListSchoolsService() {
  await ensureRolesTables();
  const rows = await db.partnerSchool.findMany({ orderBy: { name: 'asc' }, take: 500 });
  return ok(await Promise.all(rows.map(presentSchool)));
}

export async function adminCreateSchoolService(admin: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  const name = text(input?.name, 120);
  if (name.length < 2) return fail(400, 'Enter the school name (2 to 120 characters).');
  const contactEmail = cleanEmail(input?.contactEmail);
  if (contactEmail && !isEmail(contactEmail)) return fail(400, 'The school email is not valid.');
  const clash = await db.partnerSchool.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (clash) return fail(409, 'A partner school with this name already exists.');
  const row = await db.partnerSchool.create({
    data: { name, state: text(input?.state, 60) || null, contactEmail: contactEmail || null, createdById: admin.id },
  });
  await ensureSchoolChannel(row.id);
  return ok(await presentSchool(row), 'Partner school added', 201);
}

export async function adminUpdateSchoolService(id: string, input: Record<string, unknown>) {
  await ensureRolesTables();
  const row = await db.partnerSchool.findUnique({ where: { id } });
  if (!row) return fail(404, 'Partner school not found.');
  const data: Record<string, unknown> = {};
  if (input?.name !== undefined) {
    const name = text(input.name, 120);
    if (name.length < 2) return fail(400, 'Enter the school name (2 to 120 characters).');
    const clash = await db.partnerSchool.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, id: { not: id } } });
    if (clash) return fail(409, 'A partner school with this name already exists.');
    data.name = name;
  }
  if (input?.state !== undefined) data.state = text(input.state, 60) || null;
  if (input?.contactEmail !== undefined) {
    const e = cleanEmail(input.contactEmail);
    if (e && !isEmail(e)) return fail(400, 'The school email is not valid.');
    data.contactEmail = e || null;
  }
  if (input?.active !== undefined) {
    if (typeof input.active !== 'boolean') return fail(400, 'Send active as true or false.');
    data.active = input.active;
  }
  const updated = await db.partnerSchool.update({ where: { id }, data });
  if (data.name) {
    await db.communityChannel.updateMany({ where: { partnerSchoolId: id }, data: { name: updated.name } });
  }
  return ok(await presentSchool(updated), 'Partner school saved');
}

/* ----------------------------- Students: my school ----------------------------- */

export async function listSchoolsForPickerService(query: unknown) {
  await ensureRolesTables();
  const q = text(query, 60);
  const rows = await db.partnerSchool.findMany({
    where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
    orderBy: { name: 'asc' },
    take: 300,
    select: { id: true, name: true, state: true },
  });
  return ok(rows);
}

export async function joinSchoolChannel(userId: string, schoolId: string) {
  const channel = await ensureSchoolChannel(schoolId);
  if (!channel) return;
  await db.communityMembership.upsert({
    where: { channelId_userId: { channelId: channel.id, userId } },
    update: {},
    create: { channelId: channel.id, userId },
  });
}

async function leaveSchoolChannel(userId: string, schoolId: string) {
  const channel = await db.communityChannel.findUnique({ where: { partnerSchoolId: schoolId } });
  if (channel) await db.communityMembership.deleteMany({ where: { channelId: channel.id, userId } });
}

/** Links a student to a school. Used by the picker, school codes, invites and the counsellor's survey. */
export async function linkStudentToSchool(userId: string, schoolId: string, source: string, opts: { classLevel?: string | null; consent?: boolean } = {}) {
  const existing = await db.partnerSchoolStudent.findUnique({ where: { userId } });
  if (existing?.removedAt && existing.schoolId === schoolId) return { linked: false as const, reason: 'REMOVED' as const };
  if (existing && existing.schoolId !== schoolId) await leaveSchoolChannel(userId, existing.schoolId);
  const data = {
    schoolId,
    source,
    removedAt: null,
    ...(opts.classLevel !== undefined ? { classLevel: opts.classLevel } : {}),
    ...(opts.consent ? { consentAt: new Date() } : existing && existing.schoolId === schoolId ? {} : { consentAt: null }),
    ...(existing && existing.schoolId !== schoolId ? { reportApprovedAt: null, reportApprovedById: null, createdAt: new Date() } : {}),
  };
  await db.partnerSchoolStudent.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  await joinSchoolChannel(userId, schoolId);
  return { linked: true as const };
}

export async function mySchoolService(user: AnyUser) {
  await ensureRolesTables();
  if (user.role !== 'USER') return ok({ school: null, needsNotice: false, classLevel: null });
  let link = await db.partnerSchoolStudent.findUnique({ where: { userId: user.id }, include: { school: true } });
  // A counsellor invited this email before the student signed up: link them now.
  if (!link) {
    const invite = await db.partnerSchoolInvite.findFirst({ where: { email: cleanEmail(user.email) }, orderBy: { createdAt: 'desc' } });
    if (invite) {
      await linkStudentToSchool(user.id, invite.schoolId, 'invite');
      await applySchoolSeat(invite.schoolId, user.id);
      link = await db.partnerSchoolStudent.findUnique({ where: { userId: user.id }, include: { school: true } });
    }
  }
  if (!link || link.removedAt || !link.school.active) return ok({ school: null, needsNotice: false, classLevel: link?.classLevel ?? null });
  return ok({
    school: { id: link.school.id, name: link.school.name, state: link.school.state },
    classLevel: link.classLevel,
    source: link.source,
    // True until the student has been shown that their school can see their results.
    needsNotice: !link.consentAt,
  });
}

export async function setMySchoolService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  if (user.role !== 'USER') return fail(403, 'Only student accounts can pick a school.');
  const schoolId = text(input?.schoolId, 64);
  const school = schoolId ? await db.partnerSchool.findFirst({ where: { id: schoolId, active: true } }) : null;
  if (!school) return fail(404, 'Pick your school from the list.');
  if (input?.consent !== true) {
    return fail(400, `Tick the box to confirm you understand that ${school.name} can see your survey results and recommendations.`, { code: 'CONSENT_REQUIRED' });
  }
  const classLevel = CLASS_LEVELS.includes(String(input?.classLevel)) ? String(input.classLevel) : null;
  const result = await linkStudentToSchool(user.id, school.id, 'self', { classLevel, consent: true });
  if (!result.linked) {
    return fail(403, `${school.name} removed this account from its list. If this is a mistake, message the AlignTraits team in Community.`, { code: 'REMOVED' });
  }
  return ok({ school: { id: school.id, name: school.name, state: school.state }, classLevel, needsNotice: false }, `Your school is set to ${school.name}`);
}

export async function acknowledgeSchoolNoticeService(user: AnyUser) {
  await ensureRolesTables();
  await db.partnerSchoolStudent.updateMany({ where: { userId: user.id, consentAt: null }, data: { consentAt: new Date() } });
  return ok({ needsNotice: false });
}

export async function leaveMySchoolService(user: AnyUser) {
  await ensureRolesTables();
  const link = await db.partnerSchoolStudent.findUnique({ where: { userId: user.id } });
  if (!link || link.removedAt) return ok({ school: null }, 'You have no school set');
  await leaveSchoolChannel(user.id, link.schoolId);
  await db.partnerSchoolStudent.delete({ where: { userId: user.id } });
  return ok({ school: null }, 'Your school has been removed from your profile');
}

/* "My school is not listed": invite the school by email and tell the admins. */
export async function requestSchoolListingService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  const schoolName = text(input?.schoolName, 120);
  const schoolEmail = cleanEmail(input?.schoolEmail);
  if (schoolName.length < 2) return fail(400, 'Enter the name of your school.');
  if (!isEmail(schoolEmail)) return fail(400, "Enter your school's email address.");

  const mine = await db.schoolListingRequest.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - DAY) } } });
  if (mine >= 2) return fail(429, 'You have already asked today. We will follow up with your school.');

  // Each school address gets at most one invitation email a week, however many students ask.
  const recent = await db.schoolListingRequest.findFirst({ where: { schoolEmail, createdAt: { gt: new Date(Date.now() - 7 * DAY) } } });
  const studentName = displayName(user);
  const row = await db.schoolListingRequest.create({ data: { userId: user.id, studentName, schoolName, schoolEmail } });

  let emailed = false;
  if (!recent && inviteBudgetLeft() > 0) {
    emailed = await sendNotice({
      to: schoolEmail,
      subject: `A ${schoolName} student would like you on AlignTraits`,
      name: 'there',
      label: 'Invitation for your school',
      headline: `Your students are using AlignTraits`,
      lines: [
        `A student of ${schoolName} uses AlignTraits to check which courses and universities they realistically qualify for, and asked us to invite the school.`,
        'Partner schools get a school portal: counsellors can run the career survey with students, see each student’s results and realistic options, and print a take-home report for parents.',
        'If you would like to see how it works, open the link below and tell us about your school. We will get back to you.',
      ],
      ctaUrl: `${siteUrl()}/institutions/request-a-pilot`,
      ctaLabel: 'See how it works for schools',
      footer: `You are getting this one email because a student gave ${schoolEmail} as their school's address. We will not email you again unless you reply.`,
    });
    if (emailed) noteInviteEmail();
  }
  return ok({ id: row.id, emailed }, `Thank you. We will invite ${schoolName} to AlignTraits.`, 201);
}

/* ----------------------------- The school portal ----------------------------- */

async function portalSchool(user: AnyUser) {
  const staff = await db.partnerSchoolStaff.findUnique({ where: { userId: user.id }, include: { school: true } });
  return staff?.school ?? null;
}
const NO_SCHOOL = () => fail(403, 'This account is not linked to a partner school. Please contact AlignTraits.');

async function seatSummary(schoolId: string) {
  const codes = await db.schoolCode.findMany({ where: { partnerSchoolId: schoolId }, orderBy: { createdAt: 'desc' }, take: 50 });
  const now = Date.now();
  const live = codes.filter((c) => c.active && c.expiresAt.getTime() > now);
  return {
    codes,
    seats: live.reduce((a, c) => a + c.seats, 0),
    used: live.reduce((a, c) => a + c.used, 0),
  };
}

const presentCode = (c: { id: string; code: string; seats: number; used: number; active: boolean; createdAt: Date; expiresAt: Date }) => {
  const expired = c.expiresAt.getTime() <= Date.now();
  return {
    id: c.id,
    code: c.code,
    seats: c.seats,
    used: c.used,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    status: !c.active ? 'off' : expired ? 'expired' : c.used >= c.seats ? 'full' : 'active',
    daysLeft: expired ? 0 : Math.ceil((c.expiresAt.getTime() - Date.now()) / DAY),
  };
};

export async function portalOverviewService(user: AnyUser) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const [students, surveyed, seats, channel] = await Promise.all([
    db.partnerSchoolStudent.count({ where: { schoolId: school.id, removedAt: null } }),
    db.partnerSchoolStudent.count({ where: { schoolId: school.id, removedAt: null, user: { careerResults: { isNot: null } } } }),
    seatSummary(school.id),
    ensureSchoolChannel(school.id),
  ]);
  return ok({
    school: { id: school.id, name: school.name, state: school.state },
    me: { name: `${user.firstname} ${user.lastname}`.trim(), email: user.email },
    students,
    surveyed,
    seats: seats.seats,
    seatsUsed: seats.used,
    seatPrice: SEAT_PRICE,
    seatDays: SEAT_DAYS,
    channelSlug: channel?.slug ?? null,
    joinLink: `${siteUrl()}/signup?school=${school.id}`,
  });
}

const planOf = (u: { payment_plan: string | null; payment_plan_expires_at: Date | null }) => {
  const active = !!u.payment_plan && (!u.payment_plan_expires_at || u.payment_plan_expires_at.getTime() > Date.now());
  return { covered: active, plan: active ? u.payment_plan : null, until: active ? u.payment_plan_expires_at : null };
};

export async function portalStudentsService(user: AnyUser, query: unknown) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const q = text(query, 60);
  const rows = await db.partnerSchoolStudent.findMany({
    where: {
      schoolId: school.id,
      removedAt: null,
      ...(q
        ? {
            user: {
              OR: [
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      user: {
        select: {
          id: true, firstname: true, lastname: true, email: true, payment_plan: true, payment_plan_expires_at: true,
          careerResults: { select: { id: true } },
          academicRecords: { select: { id: true }, take: 1 },
          eligibilityResults: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  return ok(
    rows.map((r) => ({
      id: r.userId,
      name: `${r.user.firstname} ${r.user.lastname}`.trim(),
      initials: `${r.user.firstname[0] || ''}${r.user.lastname[0] || ''}`.toUpperCase() || 'S',
      email: r.user.email,
      classLevel: r.classLevel,
      source: r.source,
      joinedAt: r.createdAt,
      surveyDone: !!r.user.careerResults,
      resultsAdded: r.user.academicRecords.length > 0,
      matchesChecked: r.user.eligibilityResults.length > 0,
      reportApproved: !!r.reportApprovedAt,
      ...planOf(r.user),
    }))
  );
}

/** One student of this counsellor's school, or null. The school filter is in the query itself. */
async function portalStudentLink(user: AnyUser, studentId: unknown) {
  const school = await portalSchool(user);
  if (!school || typeof studentId !== 'string') return { school, link: null };
  const link = await db.partnerSchoolStudent.findFirst({
    where: { userId: studentId, schoolId: school.id, removedAt: null },
    include: { user: true },
  });
  return { school, link };
}

export async function studentReport(userId: string) {
  const insights = await studentInsights(userId);
  const top = topByTier(insights.matches);
  return {
    ...insights,
    options: (['reach', 'realistic', 'safety'] as const)
      .map((tier) => (top[tier] ? { ...top[tier]!, tierLabel: TIER_LABELS[tier] } : null))
      .filter(Boolean),
  };
}

export async function portalStudentService(user: AnyUser, studentId: unknown) {
  await ensureRolesTables();
  const { school, link } = await portalStudentLink(user, studentId);
  if (!school) return NO_SCHOOL();
  if (!link) return fail(404, 'Student not found in your school.');
  const u = link.user;
  const report = await studentReport(u.id);
  let approvedBy: string | null = null;
  if (link.reportApprovedById) {
    const by = await db.user.findUnique({ where: { id: link.reportApprovedById }, select: { firstname: true, lastname: true } });
    approvedBy = by ? `${by.firstname} ${by.lastname}`.trim() : null;
  }
  return ok({
    id: u.id,
    name: `${u.firstname} ${u.lastname}`.trim(),
    initials: `${u.firstname[0] || ''}${u.lastname[0] || ''}`.toUpperCase() || 'S',
    email: u.email,
    classLevel: link.classLevel,
    region: u.region,
    joinedAt: link.createdAt,
    source: link.source,
    hasPassword: !!u.password,
    ...planOf(u),
    school: { name: school.name },
    report,
    review: { approved: !!link.reportApprovedAt, approvedAt: link.reportApprovedAt, approvedBy },
  });
}

export async function portalReviewService(user: AnyUser, studentId: unknown, approved: unknown) {
  await ensureRolesTables();
  if (typeof approved !== 'boolean') return fail(400, 'Send approved as true or false.');
  const { school, link } = await portalStudentLink(user, studentId);
  if (!school) return NO_SCHOOL();
  if (!link) return fail(404, 'Student not found in your school.');
  await db.partnerSchoolStudent.update({
    where: { userId: link.userId },
    data: approved ? { reportApprovedAt: new Date(), reportApprovedById: user.id } : { reportApprovedAt: null, reportApprovedById: null },
  });
  return ok({ approved }, approved ? 'Approved for the parent report' : 'Approval removed');
}

export async function portalUpdateStudentService(user: AnyUser, studentId: unknown, input: Record<string, unknown>) {
  await ensureRolesTables();
  const { school, link } = await portalStudentLink(user, studentId);
  if (!school) return NO_SCHOOL();
  if (!link) return fail(404, 'Student not found in your school.');
  if (!CLASS_LEVELS.includes(String(input?.classLevel))) return fail(400, 'Pick a class: SS1, SS2, SS3 or Finished.');
  await db.partnerSchoolStudent.update({ where: { userId: link.userId }, data: { classLevel: String(input.classLevel) } });
  return ok({ classLevel: String(input.classLevel) }, 'Saved');
}

/** Covers one of this school's students with a seat from the school's live code. */
export async function portalCoverStudentService(user: AnyUser, studentId: unknown) {
  await ensureRolesTables();
  const { school, link } = await portalStudentLink(user, studentId);
  if (!school) return NO_SCHOOL();
  if (!link) return fail(404, 'Student not found in your school.');
  const u = link.user;
  if (planOf(u).covered) return ok({ covered: true }, 'This student is already covered.');
  const done = await applySchoolSeat(school.id, u.id);
  if (!done) return fail(409, 'You have no seats left. Buy more seats in Seats and code.', { code: 'NO_SEATS' });
  return ok({ covered: true }, `${u.firstname} is now covered by your school.`);
}

export async function portalRemoveStudentService(user: AnyUser, studentId: unknown) {
  await ensureRolesTables();
  const { school, link } = await portalStudentLink(user, studentId);
  if (!school) return NO_SCHOOL();
  if (!link) return fail(404, 'Student not found in your school.');
  await db.partnerSchoolStudent.update({ where: { userId: link.userId }, data: { removedAt: new Date() } });
  await leaveSchoolChannel(link.userId, school.id);
  return ok({ id: link.userId }, 'Removed from your school. They can no longer see your school channel.');
}

/* Invite students by email. Every email carries the school's join link and its live code. */
export async function portalInviteStudentsService(user: AnyUser, rawEmails: unknown) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const list = (Array.isArray(rawEmails) ? rawEmails : typeof rawEmails === 'string' ? rawEmails.split(/[\s,;]+/) : [])
    .map(cleanEmail)
    .filter(Boolean);
  const emails = Array.from(new Set(list));
  if (emails.length === 0) return fail(400, 'Enter at least one email address.');
  if (emails.length > 30) return fail(400, 'Invite up to 30 students at a time.');
  const bad = emails.filter((e) => !isEmail(e));
  if (bad.length) return fail(400, `Check this address: ${bad[0]}`);

  const sentToday = await db.partnerSchoolInvite.count({ where: { schoolId: school.id, createdAt: { gt: new Date(Date.now() - DAY) } } });
  const seats = await seatSummary(school.id);
  const liveCode = seats.codes.find((c) => c.active && c.expiresAt.getTime() > Date.now() && c.used < c.seats);

  const results: { email: string; status: 'invited' | 'already' | 'linked' | 'limit' }[] = [];
  let used = 0;
  for (const email of emails) {
    const before = await db.partnerSchoolInvite.findUnique({ where: { schoolId_email: { schoolId: school.id, email } } });
    if (before) {
      results.push({ email, status: 'already' });
      continue;
    }
    const existing = await findUserByEmail(email);
    if (existing && existing.role !== 'USER') {
      results.push({ email, status: 'already' });
      continue;
    }
    if (sentToday + used >= SCHOOL_INVITES_PER_DAY || inviteBudgetLeft() <= 0) {
      results.push({ email, status: 'limit' });
      continue;
    }
    await db.partnerSchoolInvite.create({ data: { schoolId: school.id, email, invitedById: user.id } });
    used += 1;
    if (existing) {
      const linked = await linkStudentToSchool(existing.id, school.id, 'invite');
      if (linked.linked) await applySchoolSeat(school.id, existing.id);
    }
    const sent = await sendNotice({
      to: email,
      subject: `${school.name} invites you to AlignTraits`,
      name: existing?.firstname && existing.firstname !== 'Student' ? existing.firstname : 'there',
      label: `From ${school.name}`,
      headline: 'Find the courses and universities you realistically qualify for',
      lines: [
        `Your school, ${school.name}, uses AlignTraits to help students choose a course and a university they can realistically get into and afford.`,
        existing ? 'Sign in to see your school on your dashboard.' : 'Open the link below to create your account. It takes about two minutes.',
        `${school.name} will be able to see your survey results and recommendations, so your counsellor can guide you.`,
      ],
      details: liveCode ? [{ label: 'Your school code', value: liveCode.code }] : [],
      ctaUrl: existing ? `${siteUrl()}/login` : `${siteUrl()}/signup?school=${school.id}`,
      ctaLabel: existing ? 'Sign in' : 'Create my account',
      footer: `You are getting this email because ${school.name} entered your address. If this is not your school, you can ignore it.`,
    });
    if (sent) noteInviteEmail();
    results.push({ email, status: existing ? 'linked' : 'invited' });
  }
  const invited = results.filter((r) => r.status === 'invited' || r.status === 'linked').length;
  const limited = results.filter((r) => r.status === 'limit').length;
  return ok(
    { results, left: Math.max(0, SCHOOL_INVITES_PER_DAY - sentToday - used) },
    limited
      ? `${invited} invited. ${limited} not sent: you have reached today's limit of ${SCHOOL_INVITES_PER_DAY} invitation emails. Share your school link on WhatsApp instead, or try again tomorrow.`
      : `${invited} ${invited === 1 ? 'student' : 'students'} invited`
  );
}

export async function portalInvitesService(user: AnyUser) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const [rows, sentToday] = await Promise.all([
    db.partnerSchoolInvite.findMany({ where: { schoolId: school.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    db.partnerSchoolInvite.count({ where: { schoolId: school.id, createdAt: { gt: new Date(Date.now() - DAY) } } }),
  ]);
  const users = rows.length
    ? await db.user.findMany({ where: { email: { in: rows.map((r) => r.email), mode: 'insensitive' } }, select: { email: true } })
    : [];
  const joined = new Set(users.map((u) => u.email.toLowerCase()));
  return ok({
    invites: rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt, joined: joined.has(r.email) })),
    left: Math.max(0, SCHOOL_INVITES_PER_DAY - sentToday),
    perDay: SCHOOL_INVITES_PER_DAY,
  });
}

/* The counsellor runs the survey with a student on the school's own device.
   This makes (or finds) the student's account and links it to the school; the
   survey itself is the normal one and saves to that student's account. */
export async function portalAssistedStudentService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const email = cleanEmail(input?.email);
  const firstname = text(input?.firstname, 60);
  const lastname = text(input?.lastname, 60);
  if (!firstname || !lastname) return fail(400, "Enter the student's first name and last name.");
  if (!isEmail(email)) return fail(400, "Enter the student's email address (or a parent's), so the results reach them.");
  const classLevel = CLASS_LEVELS.includes(String(input?.classLevel)) ? String(input.classLevel) : null;

  let student = await findUserByEmail(email);
  if (student && student.role !== 'USER') return fail(409, 'This email belongs to a staff account. Use the student’s own email.');
  if (student) {
    const link = await db.partnerSchoolStudent.findUnique({ where: { userId: student.id } });
    // An existing account that belongs to another school, or has never been
    // connected to this one, stays private: the counsellor invites them instead.
    if (!link || link.schoolId !== school.id || link.removedAt) {
      return fail(409, 'This email already has an AlignTraits account that is not in your school list. Invite the student instead, so they join your school themselves.', { code: 'EXISTING_ACCOUNT' });
    }
  } else {
    student = await db.user.create({ data: { firstname, lastname, email, password: '', role: Roles.USER } });
    await linkStudentToSchool(student.id, school.id, 'assisted', { classLevel });
    await applySchoolSeat(school.id, student.id);
  }
  if (classLevel) await db.partnerSchoolStudent.updateMany({ where: { userId: student.id }, data: { classLevel } });
  return ok({ id: student.id, firstname: student.firstname, lastname: student.lastname, email: student.email }, 'Ready. Hand the device to the student for the survey.', 201);
}

/* ----------------------------- Codes and seats ----------------------------- */

export async function portalCodesService(user: AnyUser) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const seats = await seatSummary(school.id);
  const [redemptions, purchases] = await Promise.all([
    db.schoolCodeRedemption.findMany({
      where: { codeId: { in: seats.codes.map((c) => c.id) } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: { id: true, firstname: true, lastname: true, email: true } } },
    }),
    db.schoolSeatPurchase.findMany({ where: { schoolId: school.id, status: 'paid' }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  return ok({
    seatPrice: SEAT_PRICE,
    seatDays: SEAT_DAYS,
    seats: seats.seats,
    seatsUsed: seats.used,
    codes: seats.codes.map((c) => ({
      ...presentCode(c),
      students: redemptions
        .filter((r) => r.codeId === c.id)
        .map((r) => ({ id: r.user.id, name: `${r.user.firstname} ${r.user.lastname}`.trim(), email: r.user.email, usedAt: r.createdAt })),
    })),
    purchases: purchases.map((p) => ({ id: p.id, seats: p.seats, amount: p.amount, paidAt: p.paidAt, reference: p.reference })),
  });
}

const paystack = Paystack(process.env.PAYSTACK_SECRET_KEY || '');
export const SCHOOL_REF_PREFIX = 'ATSCH_';

export async function portalCheckoutService(user: AnyUser, rawSeats: unknown) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  const seats = Number(rawSeats);
  if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) {
    return fail(400, `Enter how many students to cover (${MIN_SEATS} to ${MAX_SEATS}).`);
  }
  const amount = seats * SEAT_PRICE;
  const reference = `${SCHOOL_REF_PREFIX}${crypto.randomBytes(10).toString('hex')}`;
  await db.schoolSeatPurchase.create({ data: { schoolId: school.id, seats, amount, reference, createdById: user.id } });
  try {
    const response = await paystack.transaction.initialize({
      email: user.email,
      amount: amount * 100, // kobo
      reference,
      currency: 'NGN',
      callback_url: `${siteUrl()}/school-portal/seats`,
      metadata: { type: 'school_seats', schoolId: school.id, seats },
    });
    const url = response?.data?.authorization_url;
    if (!url) throw new Error('No payment link returned');
    return ok({ authorizationUrl: url, reference, seats, amount }, 'Payment started');
  } catch (error) {
    console.error('School seat payment could not start:', error);
    await db.schoolSeatPurchase.updateMany({ where: { reference, status: 'pending' }, data: { status: 'failed' } });
    return fail(502, 'We could not start the payment. Please try again in a moment.');
  }
}

/** Marks a purchase paid and makes its school code. Safe to call more than once. */
export async function fulfilSeatPurchase(reference: string, paidKobo: number) {
  await ensureRolesTables();
  const purchase = await db.schoolSeatPurchase.findUnique({ where: { reference } });
  if (!purchase) return fail(404, 'Payment not found.');
  if (purchase.status === 'paid') {
    const code = purchase.codeId ? await db.schoolCode.findUnique({ where: { id: purchase.codeId } }) : null;
    return ok({ seats: purchase.seats, code: code ? presentCode(code) : null }, 'Payment already confirmed');
  }
  if (paidKobo < purchase.amount * 100) return fail(400, 'The amount paid does not match this order.');
  // Claim it in one step so the webhook and the return page cannot both make a code.
  const claimed = await db.schoolSeatPurchase.updateMany({ where: { id: purchase.id, status: { not: 'paid' } }, data: { status: 'paid', paidAt: new Date() } });
  if (claimed.count === 0) return fulfilSeatPurchase(reference, paidKobo);
  const school = await db.partnerSchool.findUnique({ where: { id: purchase.schoolId } });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const code = await db.schoolCode.create({
        data: {
          code: generateCode(),
          schoolName: school?.name || 'Partner school',
          seats: purchase.seats,
          partnerSchoolId: purchase.schoolId,
          createdById: purchase.createdById,
          expiresAt: new Date(Date.now() + SEAT_DAYS * DAY),
        },
      });
      await db.schoolSeatPurchase.update({ where: { id: purchase.id }, data: { codeId: code.id } });
      return ok({ seats: purchase.seats, code: presentCode(code) }, `Payment confirmed. Your code for ${purchase.seats} ${purchase.seats === 1 ? 'student' : 'students'} is ready.`);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  return fail(500, 'Payment received, but the code could not be made. Please contact AlignTraits.');
}

/** After Paystack sends the counsellor back to the portal. */
export async function portalVerifyPaymentService(user: AnyUser, reference: unknown) {
  await ensureRolesTables();
  const school = await portalSchool(user);
  if (!school) return NO_SCHOOL();
  if (typeof reference !== 'string' || !reference.startsWith(SCHOOL_REF_PREFIX)) return fail(400, 'Payment reference not recognised.');
  const purchase = await db.schoolSeatPurchase.findFirst({ where: { reference, schoolId: school.id } });
  if (!purchase) return fail(404, 'Payment not found.');
  if (purchase.status === 'paid') return fulfilSeatPurchase(reference, purchase.amount * 100);
  try {
    const verification = await paystack.transaction.verify({ reference });
    if (verification?.data?.status === 'success') return await fulfilSeatPurchase(reference, Number(verification.data.amount) || 0);
    return fail(402, 'This payment has not gone through yet. If you were charged, it will show here in a few minutes.', { code: 'NOT_PAID' });
  } catch (error) {
    console.error('Could not check the school seat payment:', error);
    return fail(502, 'We could not check the payment just now. If you were charged, your code will appear here shortly.');
  }
}
