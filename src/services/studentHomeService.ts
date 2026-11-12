/*
  The student dashboard: your path, a shortlist with one course per admission
  tier, your top matches, the applications you track, what is coming up, and
  a link to share a plain-words report with your parents.
*/
import jwt from 'jsonwebtoken';
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { fail, ok } from './communityRules';
import { studentInsights, topByTier, Tier, TIERS, TIER_LABELS } from './studentInsights';
import { siteUrl } from './rolesMail';
import { studentReport } from './partnerSchoolService';

type AnyUser = { id: string; role: string; firstname: string; lastname: string; email: string; payment_plan?: string | null; payment_plan_expires_at?: Date | null; region?: string | null };

const APPLICATION_STATUSES = ['planning', 'submitted', 'under_review', 'offer', 'not_offered'] as const;
const STATUS_LABELS: Record<string, string> = {
  planning: 'Planning',
  submitted: 'Submitted',
  under_review: 'Under review',
  offer: 'Offer received',
  not_offered: 'Not offered',
};

const courseSelect = {
  id: true,
  title: true,
  university: { select: { name: true, schoolType: true, region: true, country: true } },
} as const;

export async function studentHomeService(user: AnyUser) {
  await ensureRolesTables();
  const insights = await studentInsights(user.id);
  const top = topByTier(insights.matches);
  const now = new Date();

  const [shortlistRows, applicationRows, events, link, ambassador] = await Promise.all([
    db.shortlistItem.findMany({ where: { userId: user.id } }),
    db.studentApplication.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' }, take: 20 }),
    db.communityEvent.findMany({
      where: { status: 'SCHEDULED', OR: [{ startsAt: { gte: now } }, { endsAt: { gte: now } }] },
      orderBy: { startsAt: 'asc' },
      take: 3,
    }),
    db.partnerSchoolStudent.findUnique({ where: { userId: user.id }, include: { school: { select: { id: true, name: true, active: true } } } }),
    db.ambassadorProfile.findUnique({ where: { userId: user.id } }),
  ]);
  const courseIds = Array.from(new Set([...shortlistRows.map((r) => r.courseId), ...applicationRows.map((r) => r.courseId)]));
  const courses = courseIds.length ? await db.course.findMany({ where: { id: { in: courseIds } }, select: courseSelect }) : [];
  const courseOf = (id: string) => courses.find((c) => c.id === id);
  const matchOf = (id: string) => insights.matches.find((m) => m.courseId === id) || null;

  const shortlist = TIERS.map((tier) => {
    const row = shortlistRows.find((r) => r.tier === tier);
    const c = row ? courseOf(row.courseId) : null;
    return {
      tier,
      label: TIER_LABELS[tier],
      item: row && c ? { courseId: c.id, course: c.title, school: c.university.name } : null,
    };
  });

  const applications = applicationRows
    .map((a) => {
      const c = courseOf(a.courseId);
      if (!c) return null;
      return { id: a.id, courseId: c.id, course: c.title, school: c.university.name, status: a.status, statusLabel: STATUS_LABELS[a.status] || a.status, updatedAt: a.updatedAt };
    })
    .filter(Boolean);

  const plan = user.payment_plan && (!user.payment_plan_expires_at || user.payment_plan_expires_at.getTime() > Date.now()) ? user.payment_plan : null;
  const steps = [
    { key: 'survey', label: 'Survey', done: insights.surveyDone, to: '/questionaire' },
    { key: 'careers', label: 'Careers', done: insights.careers.length > 0, to: '/dashboard/career-pathway' },
    { key: 'results', label: 'Results', done: insights.resultsAdded, to: '/dashboard/settings/records' },
    // Matches is done when every tier that has an option is saved (one per tier).
    { key: 'matches', label: 'Matches', done: shortlistRows.length > 0 && shortlistRows.length >= TIERS.filter((t) => top[t]).length, to: '/dashboard/school' },
    { key: 'apply', label: 'Apply', done: applicationRows.some((a) => a.status !== 'planning'), to: '/dashboard#applications' },
    { key: 'offer', label: 'Offer', done: applicationRows.some((a) => a.status === 'offer'), to: '/dashboard#applications' },
  ];
  const current = steps.find((s) => !s.done)?.key ?? null;

  return ok({
    firstname: user.firstname,
    plan,
    utmeScore: insights.utmeScore,
    steps: steps.map((s) => ({ ...s, current: s.key === current })),
    stepsDone: steps.filter((s) => s.done).length,
    shortlist,
    matchesChecked: insights.matchesChecked,
    matchesCheckedAt: insights.matchesCheckedAt,
    top: TIERS.map((tier) => {
      const m = top[tier];
      return m ? { ...m, tierLabel: TIER_LABELS[tier], saved: shortlistRows.some((r) => r.courseId === m.courseId) } : { tier, tierLabel: TIER_LABELS[tier], empty: true };
    }),
    matchCount: insights.matches.length,
    applications,
    applicationStatuses: APPLICATION_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    events: events.map((e) => ({ id: e.id, title: e.title, kind: e.kind, format: e.format, startsAt: e.startsAt, endsAt: e.endsAt })),
    school: link && !link.removedAt && link.school.active ? { id: link.school.id, name: link.school.name, needsNotice: !link.consentAt } : null,
    ambassador: !!ambassador?.active,
  });
}

/* ----------------------------- Shortlist ----------------------------- */

export async function saveShortlistService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  const courseId = typeof input?.courseId === 'string' ? input.courseId : '';
  const { matches } = await studentInsights(user.id);
  const match = matches.find((m) => m.courseId === courseId);
  // Only courses from the student's own eligibility check, in the tier we worked out.
  if (!match || !match.tier) return fail(404, 'Check your eligibility for this course first, then save it.');
  const tier = match.tier as Tier;
  await db.$transaction([
    db.shortlistItem.deleteMany({ where: { userId: user.id, OR: [{ tier }, { courseId }] } }),
    db.shortlistItem.create({ data: { userId: user.id, courseId, tier } }),
  ]);
  return ok({ courseId, tier }, `Saved as your ${TIER_LABELS[tier].toLowerCase()}`, 201);
}

export async function removeShortlistService(user: AnyUser, courseId: string) {
  await ensureRolesTables();
  await db.shortlistItem.deleteMany({ where: { userId: user.id, courseId } });
  return ok({ courseId }, 'Removed from your shortlist');
}

/* ----------------------------- Applications ----------------------------- */

export async function saveApplicationService(user: AnyUser, input: Record<string, unknown>) {
  await ensureRolesTables();
  const courseId = typeof input?.courseId === 'string' ? input.courseId : '';
  const status = String(input?.status || 'planning');
  if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) return fail(400, 'Pick a status for this application.');
  const course = courseId ? await db.course.findUnique({ where: { id: courseId }, select: courseSelect }) : null;
  if (!course) return fail(404, 'Course not found.');
  const count = await db.studentApplication.count({ where: { userId: user.id } });
  const existing = await db.studentApplication.findUnique({ where: { userId_courseId: { userId: user.id, courseId } } });
  if (!existing && count >= 20) return fail(400, 'You can track up to 20 applications.');
  const row = await db.studentApplication.upsert({
    where: { userId_courseId: { userId: user.id, courseId } },
    update: { status },
    create: { userId: user.id, courseId, status },
  });
  return ok(
    { id: row.id, courseId, course: course.title, school: course.university.name, status, statusLabel: STATUS_LABELS[status] },
    existing ? 'Application updated' : 'Added to your applications',
    existing ? 200 : 201
  );
}

export async function removeApplicationService(user: AnyUser, id: string) {
  await ensureRolesTables();
  await db.studentApplication.deleteMany({ where: { id, userId: user.id } });
  return ok({ id }, 'Application removed');
}

/* ----------------------------- Parent report ----------------------------- */

const REPORT_DAYS = 30;
const secret = () => process.env.JWT_SECRET as string;

/** A private link a student sends to their parents. It works for 30 days. */
export async function parentLinkService(user: AnyUser) {
  const token = jwt.sign({ sub: user.id, purpose: 'parent_report' }, secret(), { expiresIn: `${REPORT_DAYS}d` });
  const link = `${siteUrl()}/report/${token}`;
  return ok({
    link,
    days: REPORT_DAYS,
    whatsappText: `Hi, this is my AlignTraits report. It explains the courses I fit, my admission chances and what each one costs, in plain words: ${link}`,
  });
}

/** Builds the report a parent sees, or a counsellor prints. */
export async function buildReport(userId: string) {
  const [user, link] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, firstname: true, lastname: true, region: true } }),
    db.partnerSchoolStudent.findUnique({ where: { userId }, include: { school: { select: { name: true } } } }),
  ]);
  if (!user) return null;
  const report = await studentReport(userId);
  let reviewedBy: string | null = null;
  if (link?.reportApprovedById && !link.removedAt) {
    const by = await db.user.findUnique({ where: { id: link.reportApprovedById }, select: { firstname: true, lastname: true } });
    reviewedBy = by ? `${by.firstname} ${by.lastname}`.trim() : null;
  }
  return {
    student: { name: `${user.firstname} ${user.lastname}`.trim(), firstname: user.firstname, region: user.region },
    school: link && !link.removedAt ? { name: link.school.name, classLevel: link.classLevel } : null,
    review: link?.reportApprovedAt && !link.removedAt ? { approvedAt: link.reportApprovedAt, by: reviewedBy } : null,
    generatedAt: new Date(),
    ...report,
  };
}

export async function publicParentReportService(token: unknown) {
  if (typeof token !== 'string' || token.length > 800) return fail(404, 'This report link is not valid.');
  try {
    const payload = jwt.verify(token, secret()) as { sub?: string; purpose?: string };
    if (payload.purpose !== 'parent_report' || !payload.sub) return fail(404, 'This report link is not valid.');
    await ensureRolesTables();
    const report = await buildReport(payload.sub);
    if (!report) return fail(404, 'This report is no longer available.');
    return ok(report);
  } catch {
    return fail(404, 'This report link has expired. Ask for a new one.', { code: 'EXPIRED' });
  }
}
