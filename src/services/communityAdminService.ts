import { db } from '../config/db';
import { ensureCommunity, presentEvent, presentTeamMessage } from './communityService';
import { notifyEventCancelled, sendTeamReplyEmail } from './communityMail';
import { cleanBody, displayName, fail, initialsOf, isHttpUrl, ok } from './communityRules';

/*
  Admin side of Community: events, channels, moderation and the team inbox.
  Every route that calls these is behind adminLoginRequired.
*/

type Admin = { id: string; firstname?: string | null; lastname?: string | null; role?: string | null };

/* ----------------------------- Events ----------------------------- */

const KINDS = ['LIVE_SESSION', 'WORKSHOP', 'MEETUP', 'DEADLINE', 'EXAM'] as const;
const FORMATS = ['ONLINE', 'IN_PERSON'] as const;
const STATUSES = ['SCHEDULED', 'CANCELLED'] as const;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const optionalText = (v: unknown, max: number) => text(v, max) || null;

type EventInput = Record<string, unknown>;

function parseEvent(input: EventInput, partial: boolean) {
  const data: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('title')) {
    const title = text(input.title, 140);
    if (title.length < 3) return { error: 'Give the event a title (3 to 140 characters).' };
    data.title = title;
  }
  if (!partial || has('kind')) {
    if (!KINDS.includes(input.kind as any)) return { error: 'Pick a type: live session, workshop, meetup, deadline or exam.' };
    data.kind = input.kind;
  }
  if (!partial || has('format')) {
    if (!FORMATS.includes(input.format as any)) return { error: 'Pick online or in person.' };
    data.format = input.format;
  }
  if (has('status')) {
    if (!STATUSES.includes(input.status as any)) return { error: 'Unknown status.' };
    data.status = input.status;
  }
  if (!partial || has('startsAt')) {
    const d = new Date(String(input.startsAt || ''));
    if (Number.isNaN(d.getTime())) return { error: 'Set the date and start time.' };
    data.startsAt = d;
  }
  if (has('endsAt')) {
    if (input.endsAt === null || input.endsAt === '') data.endsAt = null;
    else {
      const d = new Date(String(input.endsAt));
      if (Number.isNaN(d.getTime())) return { error: 'The end time is not valid.' };
      data.endsAt = d;
    }
  }
  for (const [k, max] of [
    ['hostName', 80],
    ['hostRole', 120],
    ['platform', 60],
    ['venue', 140],
    ['address', 300],
    ['linkLabel', 60],
  ] as const) {
    if (!partial || has(k)) data[k] = optionalText(input[k], max);
  }
  if (!partial || has('summary')) data.summary = text(input.summary, 3000);
  if (!partial || has('agenda')) {
    const list = Array.isArray(input.agenda)
      ? input.agenda
      : typeof input.agenda === 'string'
        ? input.agenda.split('\n')
        : [];
    data.agenda = list
      .map((x) => text(x, 200))
      .filter(Boolean)
      .slice(0, 12);
  }
  for (const k of ['joinUrl', 'mapUrl', 'linkUrl', 'recordingUrl'] as const) {
    if (!partial || has(k)) {
      const v = input[k];
      if (v === null || v === undefined || v === '') data[k] = null;
      else if (!isHttpUrl(v)) return { error: `The ${k === 'joinUrl' ? 'meeting' : k === 'mapUrl' ? 'map' : k === 'linkUrl' ? 'information' : 'recording'} link must start with https://` };
      else data[k] = String(v).trim().slice(0, 500);
    }
  }
  return { data };
}

function checkEventShape(e: { startsAt: Date; endsAt: Date | null }) {
  if (e.endsAt && e.endsAt <= e.startsAt) return 'The end time must be after the start time.';
  return null;
}

const adminEventInclude = { _count: { select: { reminders: true } } };

export async function adminListEventsService() {
  await ensureCommunity();
  const rows = await db.communityEvent.findMany({ orderBy: { startsAt: 'desc' }, take: 300, include: adminEventInclude });
  return ok(rows.map(presentEvent));
}

export async function adminCreateEventService(admin: Admin, input: EventInput) {
  await ensureCommunity();
  const parsed = parseEvent(input || {}, false);
  if (!parsed.data) return fail(400, parsed.error || 'Check the event details.');
  const d = parsed.data as any;
  const problem = checkEventShape({ startsAt: d.startsAt, endsAt: d.endsAt ?? null });
  if (problem) return fail(400, problem);
  const row = await db.communityEvent.create({
    data: { ...d, createdById: admin.id },
    include: adminEventInclude,
  });
  return ok(presentEvent(row), 'Event created', 201);
}

export async function adminUpdateEventService(id: string, input: EventInput) {
  await ensureCommunity();
  const existing = await db.communityEvent.findUnique({ where: { id } });
  if (!existing) return fail(404, 'Event not found.');
  const parsed = parseEvent(input || {}, true);
  if (!parsed.data) return fail(400, parsed.error || 'Check the event details.');
  const d = parsed.data as any;
  const problem = checkEventShape({
    startsAt: d.startsAt ?? existing.startsAt,
    endsAt: d.endsAt !== undefined ? d.endsAt : existing.endsAt,
  });
  if (problem) return fail(400, problem);
  const row = await db.communityEvent.update({ where: { id }, data: d, include: adminEventInclude });
  // If the time moved, send reminders again for the new time.
  if (d.startsAt && d.startsAt.getTime() !== existing.startsAt.getTime()) {
    await db.communityEventReminder.updateMany({ where: { eventId: id }, data: { dayEmailAt: null, hourEmailAt: null } });
  }
  if (d.status === 'CANCELLED' && existing.status !== 'CANCELLED') {
    notifyEventCancelled(id).catch((e) => console.error('Could not email the cancellation:', e));
  }
  return ok(presentEvent(row), 'Event saved');
}

export async function adminDeleteEventService(id: string) {
  await ensureCommunity();
  const existing = await db.communityEvent.findUnique({ where: { id } });
  if (!existing) return fail(404, 'Event not found.');
  await db.communityEvent.delete({ where: { id } });
  return ok({ id }, 'Event deleted');
}

/* ----------------------------- Channels ----------------------------- */

export async function adminListChannelsService() {
  await ensureCommunity();
  const channels = await db.communityChannel.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { memberships: true, messages: true } } },
  });
  const openReports = await db.communityReport.findMany({
    where: { resolvedAt: null },
    select: { message: { select: { channelId: true } } },
  });
  return ok(
    channels.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      welcome: c.welcome,
      archived: c.archived,
      memberCount: c._count.memberships,
      messageCount: c._count.messages,
      openReports: openReports.filter((r) => r.message.channelId === c.id).length,
    }))
  );
}

export async function adminUpdateChannelService(id: string, input: Record<string, unknown>) {
  await ensureCommunity();
  const channel = await db.communityChannel.findUnique({ where: { id } });
  if (!channel) return fail(404, 'Channel not found.');
  const data: Record<string, string> = {};
  if (input.description !== undefined) {
    const v = text(input.description, 160);
    if (v.length < 3) return fail(400, 'Write a short description.');
    data.description = v;
  }
  if (input.welcome !== undefined) {
    const v = text(input.welcome, 600);
    if (v.length < 3) return fail(400, 'Write a welcome message.');
    data.welcome = v;
  }
  const row = await db.communityChannel.update({ where: { id }, data });
  return ok(row, 'Channel saved');
}

const authorSelect = { select: { id: true, firstname: true, lastname: true, email: true, role: true } } as const;

function presentAdminMessage(m: any) {
  return {
    id: m.id,
    body: m.body,
    createdAt: m.createdAt,
    pinned: m.pinned,
    hidden: m.hidden,
    fromStaff: m.fromStaff,
    reportCount: m._count?.reports ?? 0,
    author: {
      id: m.user?.id,
      name: m.user ? `${m.user.firstname} ${m.user.lastname}`.trim() : 'Unknown',
      shownAs: displayName(m.user),
      initials: initialsOf(m.user),
      email: m.user?.email,
    },
  };
}

export async function adminChannelMessagesService(id: string, before?: unknown) {
  await ensureCommunity();
  const channel = await db.communityChannel.findUnique({ where: { id } });
  if (!channel) return fail(404, 'Channel not found.');
  const b = typeof before === 'string' && before ? new Date(before) : null;
  const rows = await db.communityMessage.findMany({
    where: { channelId: id, deletedAt: null, ...(b && !Number.isNaN(b.getTime()) ? { createdAt: { lt: b } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: { user: authorSelect, _count: { select: { reports: true } } },
  });
  return ok({ channel, messages: rows.reverse().map(presentAdminMessage), hasMore: rows.length === 60 });
}

export async function adminPostMessageService(admin: Admin, channelId: string, rawBody: unknown) {
  await ensureCommunity();
  const channel = await db.communityChannel.findUnique({ where: { id: channelId } });
  if (!channel) return fail(404, 'Channel not found.');
  const { body, error } = cleanBody(rawBody);
  if (!body) return fail(400, error || 'Write a message first.');
  const row = await db.communityMessage.create({
    data: { channelId, userId: admin.id, body, fromStaff: true },
    include: { user: authorSelect, _count: { select: { reports: true } } },
  });
  return ok(presentAdminMessage(row), 'Posted', 201);
}

export async function adminPinMessageService(id: string, pinned: unknown) {
  await ensureCommunity();
  if (typeof pinned !== 'boolean') return fail(400, 'Send pinned as true or false.');
  const message = await db.communityMessage.findFirst({ where: { id, deletedAt: null } });
  if (!message) return fail(404, 'Message not found.');
  await db.communityMessage.update({ where: { id }, data: { pinned } });
  return ok({ id, pinned }, pinned ? 'Message pinned' : 'Message unpinned');
}

export async function adminDeleteMessageService(admin: Admin, id: string) {
  await ensureCommunity();
  const message = await db.communityMessage.findFirst({ where: { id, deletedAt: null } });
  if (!message) return fail(404, 'Message not found.');
  await db.$transaction([
    db.communityMessage.update({ where: { id }, data: { deletedAt: new Date(), pinned: false } }),
    db.communityReport.updateMany({
      where: { messageId: id, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution: `deleted by ${displayName(admin)}` },
    }),
  ]);
  return ok({ id }, 'Message deleted');
}

export async function adminKeepMessageService(admin: Admin, id: string) {
  await ensureCommunity();
  const message = await db.communityMessage.findFirst({ where: { id, deletedAt: null } });
  if (!message) return fail(404, 'Message not found.');
  await db.$transaction([
    db.communityMessage.update({ where: { id }, data: { hidden: false } }),
    db.communityReport.updateMany({
      where: { messageId: id, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution: `kept by ${displayName(admin)}` },
    }),
  ]);
  return ok({ id }, 'Message kept and shown again');
}

export async function adminReportsService() {
  await ensureCommunity();
  const reports = await db.communityReport.findMany({
    where: { resolvedAt: null, message: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      message: { include: { user: authorSelect, channel: { select: { name: true, slug: true } } } },
      reporter: { select: { firstname: true, lastname: true } },
    },
  });
  const grouped = new Map<string, any>();
  for (const r of reports) {
    const g =
      grouped.get(r.messageId) ||
      {
        message: { ...presentAdminMessage(r.message), channel: r.message.channel },
        reports: [] as { reporter: string; reason: string | null; createdAt: Date }[],
      };
    g.reports.push({ reporter: displayName(r.reporter), reason: r.reason, createdAt: r.createdAt });
    grouped.set(r.messageId, g);
  }
  return ok(Array.from(grouped.values()));
}

const MUTE_DAYS = [0, 1, 7, 30];

export async function adminMuteUserService(userId: string, days: unknown, reason: unknown) {
  await ensureCommunity();
  const n = Number(days);
  if (!MUTE_DAYS.includes(n)) return fail(400, 'Mute for 1, 7 or 30 days, or 0 to unmute.');
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, firstname: true, lastname: true } });
  if (!user) return fail(404, 'Student not found.');
  const mutedUntil = n === 0 ? null : new Date(Date.now() + n * 24 * 3600 * 1000);
  await db.communityProfile.upsert({
    where: { userId },
    update: { mutedUntil, muteReason: text(reason, 300) || null },
    create: { userId, mutedUntil, muteReason: text(reason, 300) || null },
  });
  return ok(
    { userId, mutedUntil },
    n === 0 ? `${displayName(user)} can post again` : `${displayName(user)} can't post for ${n} ${n === 1 ? 'day' : 'days'}`
  );
}

/* ----------------------------- Team inbox ----------------------------- */

export async function adminInboxService() {
  await ensureCommunity();
  const threads = await db.communityTeamThread.findMany({
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    include: {
      user: { select: { id: true, firstname: true, lastname: true, email: true, region: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  const data = await Promise.all(
    threads.map(async (t) => {
      const unread = await db.communityTeamMessage.count({
        where: { threadId: t.id, fromStaff: false, ...(t.staffReadAt ? { createdAt: { gt: t.staffReadAt } } : {}) },
      });
      const last = t.messages[0];
      return {
        id: t.id,
        student: {
          id: t.user.id,
          name: `${t.user.firstname} ${t.user.lastname}`.trim(),
          email: t.user.email,
          region: t.user.region,
          initials: initialsOf(t.user),
        },
        lastMessage: last ? { body: last.body.slice(0, 160), fromStaff: last.fromStaff, createdAt: last.createdAt } : null,
        lastMessageAt: t.lastMessageAt,
        unread,
      };
    })
  );
  return ok(data);
}

export async function adminInboxThreadService(threadId: string) {
  await ensureCommunity();
  const thread = await db.communityTeamThread.findUnique({
    where: { id: threadId },
    include: { user: { select: { id: true, firstname: true, lastname: true, email: true, region: true } } },
  });
  if (!thread) return fail(404, 'Conversation not found.');
  const messages = await db.communityTeamMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
    take: 300,
    include: { sender: { select: { firstname: true, lastname: true } } },
  });
  await db.communityTeamThread.update({ where: { id: threadId }, data: { staffReadAt: new Date() } });
  return ok({
    id: thread.id,
    student: {
      id: thread.user.id,
      name: `${thread.user.firstname} ${thread.user.lastname}`.trim(),
      email: thread.user.email,
      region: thread.user.region,
      initials: initialsOf(thread.user),
    },
    messages: messages.map(presentTeamMessage),
  });
}

export async function adminInboxReplyService(admin: Admin, threadId: string, rawBody: unknown) {
  await ensureCommunity();
  const thread = await db.communityTeamThread.findUnique({
    where: { id: threadId },
    include: { user: { select: { email: true, firstname: true } } },
  });
  if (!thread) return fail(404, 'Conversation not found.');
  const { body, error } = cleanBody(rawBody);
  if (!body) return fail(400, error || 'Write a reply first.');
  const now = new Date();
  const row = await db.communityTeamMessage.create({
    data: { threadId, senderId: admin.id, fromStaff: true, body },
    include: { sender: { select: { firstname: true, lastname: true } } },
  });
  await db.communityTeamThread.update({ where: { id: threadId }, data: { lastMessageAt: now, staffReadAt: now } });
  // Let the student know by email, unless they have the conversation open right now.
  if (thread.studentReadAt < new Date(now.getTime() - 2 * 60 * 1000)) {
    sendTeamReplyEmail(thread.user).catch((e) => console.error('Could not email the team reply:', e));
  }
  return ok(presentTeamMessage(row), 'Reply sent', 201);
}
