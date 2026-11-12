/*
  Private chats between classmates.

  - Only students of the same partner school can find each other, and only by name.
  - A chat starts as an invitation. Nothing can be sent until the other student accepts.
  - The same safety rules as channels apply (no phone numbers, emails or outside links),
    because most students are under 18.
  - Either student can block the other or report the chat to the AlignTraits team.
  - When either student is no longer in the school, the chat becomes read only.
*/
import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';
import { checkStudentMessage, cleanBody, displayName, fail, initialsOf, ok, rateLimit } from './communityRules';
import { badgesFor } from './communityBadges';

type AnyUser = { id: string; role?: string | null; firstname?: string | null; lastname?: string | null; emailVerified?: Date | null };

const pair = (a: string, b: string) => (a < b ? { lowId: a, highId: b } : { lowId: b, highId: a });
const otherOf = (t: { lowId: string; highId: string }, me: string) => (t.lowId === me ? t.highId : t.lowId);
const myReadField = (t: { lowId: string }, me: string) => (t.lowId === me ? 'lowReadAt' : 'highReadAt');

async function liveSchoolOf(userId: string) {
  const link = await db.partnerSchoolStudent.findUnique({ where: { userId }, include: { school: { select: { id: true, name: true, active: true } } } });
  return link && !link.removedAt && link.school.active ? link.school : null;
}

async function requireSchool(user: AnyUser) {
  if (user.role !== 'USER') return { error: fail(403, 'Private chats are for students.') };
  const school = await liveSchoolOf(user.id);
  if (!school) {
    return { error: fail(409, 'Add your school in Profile and settings to chat privately with classmates.', { code: 'NO_SCHOOL' }) };
  }
  return { school };
}

const person = (u: { id: string; firstname: string; lastname: string } | null | undefined) => ({
  id: u?.id ?? '',
  name: displayName(u),
  initials: initialsOf(u),
});

export async function searchClassmatesService(user: AnyUser, query: unknown) {
  await ensureRolesTables();
  const { school, error } = await requireSchool(user);
  if (error) return error;
  const q = typeof query === 'string' ? query.trim().slice(0, 40) : '';
  if (q.length < 2) return ok({ school: { name: school!.name }, people: [] });
  const words = q.split(/\s+/).filter(Boolean).slice(0, 2);
  const rows = await db.partnerSchoolStudent.findMany({
    where: {
      schoolId: school!.id,
      removedAt: null,
      userId: { not: user.id },
      user: {
        role: 'USER',
        AND: words.map((w) => ({ OR: [{ firstname: { contains: w, mode: 'insensitive' as const } }, { lastname: { contains: w, mode: 'insensitive' as const } }] })),
      },
    },
    take: 20,
    include: { user: { select: { id: true, firstname: true, lastname: true } } },
  });
  const threads = rows.length
    ? await db.directThread.findMany({ where: { OR: rows.map((r) => pair(user.id, r.userId)) } })
    : [];
  return ok({
    school: { name: school!.name },
    people: rows.map((r) => {
      const t = threads.find((x) => otherOf(x, user.id) === r.userId && (x.lowId === user.id || x.highId === user.id));
      return {
        ...person(r.user),
        classLevel: r.classLevel,
        // none | sent | received | accepted | declined | blocked
        status: !t ? 'none' : t.status === 'pending' ? (t.requestedById === user.id ? 'sent' : 'received') : t.status,
        threadId: t?.id ?? null,
      };
    }),
  });
}

export async function inviteClassmateService(user: AnyUser, otherId: unknown) {
  await ensureRolesTables();
  const { school, error } = await requireSchool(user);
  if (error) return error;
  if (!user.emailVerified) return fail(403, 'Verify your email to chat with classmates.', { code: 'VERIFY_EMAIL' });
  if (typeof otherId !== 'string' || otherId === user.id) return fail(400, 'Pick a classmate.');
  const theirSchool = await liveSchoolOf(otherId);
  const other = await db.user.findUnique({ where: { id: otherId }, select: { id: true, role: true, firstname: true, lastname: true } });
  if (!other || other.role !== 'USER' || theirSchool?.id !== school!.id) return fail(404, 'Classmate not found in your school.');

  const limit = rateLimit(`dm-invite:${user.id}`, { gapMs: 1000, max: 20, windowMs: 24 * 60 * 60 * 1000 });
  if (!limit.ok) return fail(429, 'You have sent a lot of chat invitations today. Try again tomorrow.', { code: 'TOO_FAST' });

  const key = pair(user.id, otherId);
  const existing = await db.directThread.findUnique({ where: { lowId_highId: key } });
  if (existing) {
    if (existing.status === 'blocked') return fail(403, 'You cannot chat with this student.', { code: 'BLOCKED' });
    if (existing.status === 'accepted') return ok({ threadId: existing.id, status: 'accepted' }, 'You can already chat');
    if (existing.status === 'pending') {
      if (existing.requestedById === user.id) return ok({ threadId: existing.id, status: 'sent' }, 'Invitation already sent');
      // They invited me first: inviting back accepts.
      await db.directThread.update({ where: { id: existing.id }, data: { status: 'accepted', acceptedAt: new Date() } });
      return ok({ threadId: existing.id, status: 'accepted' }, `You and ${other.firstname} can now chat`);
    }
    // Declined before: only the person who declined can restart it, so invites cannot be repeated to pressure someone.
    if (existing.requestedById === user.id) return fail(409, `${other.firstname} declined your invitation.`, { code: 'DECLINED' });
    await db.directThread.update({ where: { id: existing.id }, data: { status: 'pending', requestedById: user.id, acceptedAt: null } });
    return ok({ threadId: existing.id, status: 'sent' }, `Invitation sent to ${other.firstname}`, 201);
  }
  const row = await db.directThread.create({ data: { ...key, requestedById: user.id } });
  return ok({ threadId: row.id, status: 'sent' }, `Invitation sent to ${other.firstname}`, 201);
}

async function myThread(user: AnyUser, id: unknown) {
  if (typeof id !== 'string' || id.length > 64) return null;
  const t = await db.directThread.findUnique({ where: { id } });
  if (!t || (t.lowId !== user.id && t.highId !== user.id)) return null;
  return t;
}

export async function respondInviteService(user: AnyUser, id: unknown, accept: unknown) {
  await ensureRolesTables();
  if (typeof accept !== 'boolean') return fail(400, 'Send accept as true or false.');
  const t = await myThread(user, id);
  if (!t || t.status !== 'pending' || t.requestedById === user.id) return fail(404, 'Invitation not found.');
  const updated = await db.directThread.update({
    where: { id: t.id },
    data: accept ? { status: 'accepted', acceptedAt: new Date() } : { status: 'declined' },
  });
  return ok({ threadId: updated.id, status: updated.status }, accept ? 'Invitation accepted' : 'Invitation declined');
}

export async function listThreadsService(user: AnyUser) {
  await ensureRolesTables();
  const school = user.role === 'USER' ? await liveSchoolOf(user.id) : null;
  const threads = await db.directThread.findMany({
    where: { OR: [{ lowId: user.id }, { highId: user.id }], status: { in: ['pending', 'accepted'] } },
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: 100,
  });
  const others = await db.user.findMany({
    where: { id: { in: threads.map((t) => otherOf(t, user.id)) } },
    select: { id: true, firstname: true, lastname: true, role: true },
  });
  const badges = await badgesFor(others);
  const data = await Promise.all(
    threads.map(async (t) => {
      const other = others.find((o) => o.id === otherOf(t, user.id));
      const readAt = (t as any)[myReadField(t, user.id)] as Date | null;
      const [unread, last] = await Promise.all([
        t.status === 'accepted'
          ? db.directMessage.count({ where: { threadId: t.id, userId: { not: user.id }, ...(readAt ? { createdAt: { gt: readAt } } : {}) } })
          : 0,
        db.directMessage.findFirst({ where: { threadId: t.id }, orderBy: { createdAt: 'desc' }, select: { body: true, userId: true, createdAt: true } }),
      ]);
      return {
        id: t.id,
        with: { ...person(other), badge: other ? badges.get(other.id) ?? null : null },
        status: t.status === 'pending' ? (t.requestedById === user.id ? 'sent' : 'received') : 'accepted',
        unread,
        last: last ? { body: last.body.slice(0, 120), mine: last.userId === user.id, at: last.createdAt } : null,
        createdAt: t.createdAt,
      };
    })
  );
  return ok({ school: school ? { name: school.name } : null, threads: data });
}

export async function threadMessagesService(user: AnyUser, id: unknown, query: { after?: unknown }) {
  await ensureRolesTables();
  const t = await myThread(user, id);
  if (!t || (t.status !== 'accepted' && t.status !== 'pending')) return fail(404, 'Chat not found.');
  const otherId = otherOf(t, user.id);
  const other = await db.user.findUnique({ where: { id: otherId }, select: { id: true, firstname: true, lastname: true, role: true } });
  const after = typeof query.after === 'string' && !Number.isNaN(Date.parse(query.after)) ? new Date(query.after) : null;
  const rows =
    t.status === 'accepted'
      ? after
        ? await db.directMessage.findMany({ where: { threadId: t.id, createdAt: { gte: after } }, orderBy: { createdAt: 'asc' }, take: 200 })
        : (await db.directMessage.findMany({ where: { threadId: t.id }, orderBy: { createdAt: 'desc' }, take: 100 })).reverse()
      : [];
  if (t.status === 'accepted') {
    await db.directThread.update({ where: { id: t.id }, data: { [myReadField(t, user.id)]: new Date() } });
  }
  const [mine, theirs] = await Promise.all([liveSchoolOf(user.id), liveSchoolOf(otherId)]);
  const canSend = t.status === 'accepted' && !!mine && mine.id === theirs?.id;
  const badges = other ? await badgesFor([other]) : new Map();
  return ok({
    thread: {
      id: t.id,
      status: t.status === 'pending' ? (t.requestedById === user.id ? 'sent' : 'received') : 'accepted',
      with: { ...person(other), badge: other ? badges.get(other.id) ?? null : null },
      canSend,
      readOnlyReason: t.status === 'accepted' && !canSend ? 'You are no longer in the same school, so this chat is read only.' : null,
      reported: !!t.reportedAt && t.reportedById === user.id,
    },
    messages: rows.map((m) => ({ id: m.id, body: m.body, mine: m.userId === user.id, createdAt: m.createdAt })),
    serverTime: new Date(),
  });
}

export async function sendDirectMessageService(user: AnyUser, id: unknown, rawBody: unknown) {
  await ensureRolesTables();
  const t = await myThread(user, id);
  if (!t || t.status !== 'accepted') return fail(404, 'Chat not found, or the invitation has not been accepted yet.');
  const [mine, theirs] = await Promise.all([liveSchoolOf(user.id), liveSchoolOf(otherOf(t, user.id))]);
  if (!mine || mine.id !== theirs?.id) return fail(403, 'You are no longer in the same school, so this chat is read only.', { code: 'READ_ONLY' });
  const profile = await db.communityProfile.findUnique({ where: { userId: user.id } });
  if (profile?.mutedUntil && profile.mutedUntil > new Date()) return fail(403, 'A moderator has paused your posting. You can still read.', { code: 'MUTED' });
  const { body, error } = cleanBody(rawBody);
  if (!body) return fail(400, error || 'Write a message first.', { code: 'EMPTY' });
  const problem = checkStudentMessage(body);
  if (problem) return fail(400, problem, { code: 'NOT_ALLOWED' });
  const limit = rateLimit(`dm:${user.id}`, { gapMs: 1500, max: 40, windowMs: 10 * 60 * 1000 });
  if (!limit.ok) return fail(429, limit.message, { code: 'TOO_FAST' });
  const now = new Date();
  const row = await db.directMessage.create({ data: { threadId: t.id, userId: user.id, body } });
  await db.directThread.update({ where: { id: t.id }, data: { lastMessageAt: now, [myReadField(t, user.id)]: now } });
  return ok({ id: row.id, body: row.body, mine: true, createdAt: row.createdAt }, 'Sent', 201);
}

export async function blockThreadService(user: AnyUser, id: unknown) {
  await ensureRolesTables();
  const t = await myThread(user, id);
  if (!t) return fail(404, 'Chat not found.');
  await db.directThread.update({ where: { id: t.id }, data: { status: 'blocked', blockedById: user.id } });
  return ok({ id: t.id }, 'Blocked. They can no longer message you or invite you.');
}

export async function reportThreadService(user: AnyUser, id: unknown, reason: unknown) {
  await ensureRolesTables();
  const t = await myThread(user, id);
  if (!t) return fail(404, 'Chat not found.');
  const text = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  await db.directThread.update({
    where: { id: t.id },
    data: { reportedById: user.id, reportedAt: new Date(), reportReason: text || null, status: 'blocked', blockedById: user.id },
  });
  return ok({ id: t.id }, 'Thanks for telling us. The AlignTraits team will look at this chat, and the other student can no longer message you.');
}

/** Unread messages and waiting invitations, for the menu badge. */
export async function directUnreadCount(userId: string) {
  try {
    const threads = await db.directThread.findMany({
      where: { OR: [{ lowId: userId }, { highId: userId }], status: { in: ['pending', 'accepted'] } },
    });
    let unread = 0;
    let requests = 0;
    for (const t of threads) {
      if (t.status === 'pending') {
        if (t.requestedById !== userId) requests += 1;
        continue;
      }
      const readAt = (t as any)[myReadField(t, userId)] as Date | null;
      if (t.lastMessageAt && (!readAt || t.lastMessageAt > readAt)) {
        unread += await db.directMessage.count({ where: { threadId: t.id, userId: { not: userId }, ...(readAt ? { createdAt: { gt: readAt } } : {}) } });
      }
    }
    return { unread, requests };
  } catch {
    return { unread: 0, requests: 0 };
  }
}

/* ----------------------------- Admin ----------------------------- */

export async function adminReportedChatsService() {
  await ensureRolesTables();
  const threads = await db.directThread.findMany({ where: { reportedAt: { not: null } }, orderBy: { reportedAt: 'desc' }, take: 100 });
  const ids = Array.from(new Set(threads.flatMap((t) => [t.lowId, t.highId])));
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstname: true, lastname: true, email: true } });
  const nameOf = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? { id: u.id, name: `${u.firstname} ${u.lastname}`.trim(), email: u.email } : { id, name: 'Deleted account', email: '' };
  };
  const data = await Promise.all(
    threads.map(async (t) => ({
      id: t.id,
      reportedAt: t.reportedAt,
      reason: t.reportReason,
      reportedBy: nameOf(t.reportedById!),
      other: nameOf(t.reportedById === t.lowId ? t.highId : t.lowId),
      messages: (await db.directMessage.findMany({ where: { threadId: t.id }, orderBy: { createdAt: 'desc' }, take: 30 }))
        .reverse()
        .map((m) => ({ id: m.id, body: m.body, from: nameOf(m.userId).name, createdAt: m.createdAt })),
    }))
  );
  return ok(data);
}

export async function adminCloseReportedChatService(id: string) {
  await ensureRolesTables();
  const t = await db.directThread.findUnique({ where: { id } });
  if (!t || !t.reportedAt) return fail(404, 'Report not found.');
  await db.directThread.update({ where: { id }, data: { reportedAt: null } });
  return ok({ id }, 'Report closed. The chat stays blocked.');
}
