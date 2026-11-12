/*
  Requests: everything people ask us for, in one list for admins.
    school      a school, tutorial centre or university asked for a pilot (website form)
    ambassador  a student applied to be an ambassador (website form)
    loan        someone registered interest in student loans (loan page, waitlist)
    listing     a student said their school is not on AlignTraits and gave its email
    event       an ambassador suggested an event that needs approval
    chat        a student reported a private chat
  The badge counts what arrived since the admin last opened Requests.
*/
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { fail, ok } from './communityRules';

type Admin = { id: string };
const KINDS = ['school', 'ambassador', 'loan', 'listing'] as const;
const STATUS_BY_KIND: Record<string, string[]> = {
  school: ['new', 'contacted', 'scheduled', 'running', 'closed'],
  ambassador: ['new', 'contacted', 'consent_received', 'accepted', 'declined'],
  listing: ['new', 'contacted', 'partnered', 'closed'],
};

async function seenAt(userId: string) {
  const row = await db.staffSeen.findUnique({ where: { userId } });
  return row?.requestsSeenAt ?? new Date(0);
}

export async function requestsSummaryService(admin: Admin) {
  await ensureRolesTables();
  const since = await seenAt(admin.id);
  const after = { createdAt: { gt: since } };
  const [school, ambassador, loan, listing, events, chats] = await Promise.all([
    db.pilotRequest.count({ where: after }),
    db.ambassadorApplication.count({ where: after }),
    db.waitList.count({ where: after }),
    db.schoolListingRequest.count({ where: after }),
    db.communityEvent.count({ where: { status: 'DRAFT' } }),
    db.directThread.count({ where: { reportedAt: { not: null } } }),
  ]);
  const fresh = school + ambassador + loan + listing;
  return ok({ new: { school, ambassador, loan, listing }, eventsToApprove: events, chatsReported: chats, total: fresh + events + chats });
}

export async function listRequestsService(admin: Admin, rawKind: unknown) {
  await ensureRolesTables();
  const kind = KINDS.includes(rawKind as any) ? (rawKind as string) : 'school';
  const since = await seenAt(admin.id);
  let items: any[] = [];
  if (kind === 'school') {
    const rows = await db.pilotRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    items = rows.map((r) => ({
      id: r.id,
      title: r.institutionName,
      subtitle: `${r.institutionType.replace(/_/g, ' ')} · ${r.state}`,
      status: r.status,
      createdAt: r.createdAt,
      fields: [
        ['Contact', `${r.fullName} (${r.role})`],
        ['Email', r.workEmail],
        ['WhatsApp', r.whatsapp],
        ['Who would take part', r.participants.join(', ') || r.programmes || ''],
        ['Students', r.studentRange.replace(/_/g, ' ')],
        ['Start', r.startWhen.replace(/_/g, ' ')],
        ['Note', r.note || ''],
      ].filter(([, v]) => v),
      email: r.workEmail,
      whatsapp: r.whatsapp,
    }));
  } else if (kind === 'ambassador') {
    const rows = await db.ambassadorApplication.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    items = rows.map((r) => ({
      id: r.id,
      title: r.fullName,
      subtitle: `${r.school} · ${r.classLevel} · ${r.state}`,
      status: r.status,
      createdAt: r.createdAt,
      fields: [
        ['Age group', r.ageGroup === 'under_18' ? 'Under 18: get consent from the parent or guardian first' : '18 or older'],
        ['WhatsApp', r.whatsapp],
        ['Parent or guardian', r.guardianName ? `${r.guardianName} (${r.guardianPhone || ''})` : ''],
        ['Why', r.reason],
      ].filter(([, v]) => v),
      whatsapp: r.whatsapp,
      under18: r.ageGroup === 'under_18',
    }));
  } else if (kind === 'loan') {
    const rows = await db.waitList.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    items = rows.map((r) => ({ id: r.id, title: r.email, subtitle: 'Registered interest in student loans', status: null, createdAt: r.createdAt, fields: [], email: r.email }));
  } else {
    const rows = await db.schoolListingRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    items = rows.map((r) => ({
      id: r.id,
      title: r.schoolName,
      subtitle: `Asked by ${r.studentName}`,
      status: r.status,
      createdAt: r.createdAt,
      fields: [['School email', r.schoolEmail]],
      email: r.schoolEmail,
    }));
  }
  return ok({ kind, items: items.map((i) => ({ ...i, isNew: i.createdAt > since })), statuses: STATUS_BY_KIND[kind] || [] });
}

/** Opening Requests clears the badge. */
export async function markRequestsSeenService(admin: Admin) {
  await ensureRolesTables();
  const now = new Date();
  await db.staffSeen.upsert({ where: { userId: admin.id }, update: { requestsSeenAt: now }, create: { userId: admin.id, requestsSeenAt: now } });
  return ok({ seenAt: now });
}

export async function setRequestStatusService(rawKind: unknown, id: string, status: unknown) {
  await ensureRolesTables();
  const kind = String(rawKind);
  const allowed = STATUS_BY_KIND[kind];
  if (!allowed) return fail(400, 'This kind of request has no status.');
  if (typeof status !== 'string' || !allowed.includes(status)) return fail(400, 'Pick one of the listed statuses.');
  try {
    if (kind === 'school') await db.pilotRequest.update({ where: { id }, data: { status } });
    else if (kind === 'ambassador') await db.ambassadorApplication.update({ where: { id }, data: { status } });
    else await db.schoolListingRequest.update({ where: { id }, data: { status } });
  } catch (error: any) {
    if (error?.code === 'P2025') return fail(404, 'Request not found.');
    throw error;
  }
  return ok({ id, status }, 'Status saved');
}
