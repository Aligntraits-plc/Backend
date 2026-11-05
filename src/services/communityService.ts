import { db } from '../config/db';
import { ensureCommunityTables } from './communityTables';
import {
  REACTIONS,
  REPORTS_TO_HIDE,
  checkStudentMessage,
  cleanBody,
  displayName,
  fail,
  initialsOf,
  isStaff,
  mapLinkFor,
  ok,
  rateLimit,
} from './communityRules';

/*
  Community for students: public channels, a private conversation with the
  AlignTraits team, and events with reminders.
*/

type AnyUser = {
  id: string;
  firstname?: string | null;
  lastname?: string | null;
  role?: string | null;
  emailVerified?: Date | null;
};

// The two channels Community starts with. Created once if missing; admin edits are kept.
const SEED_CHANNELS = [
  {
    slug: 'jamb-candidates',
    name: 'jamb-candidates',
    description: 'Exam slips, CBT centres and UTME prep',
    welcome:
      'Exam slips, CBT centres and UTME prep. Be kind, help each other, and link an official source (like jamb.gov.ng) when you share a fact.',
    position: 0,
  },
  {
    slug: 'scholarships-and-funding',
    name: 'scholarships-and-funding',
    description: 'Scholarships, loans and ways to pay for university',
    welcome:
      'Scholarships, student loans and ways to pay for university. Share the official link for every opportunity. Never pay anyone to apply for a scholarship.',
    position: 1,
  },
];

/*
  Key dates students should know about, added once when Community has no events yet,
  so Events is never empty on launch. Admins edit them in Admin > Community.
  Sources (checked 5 November 2026):
  - Admission deadlines: JAMB, reported by BusinessDay on 28 September 2026.
  - 2027 exam windows: the Federal Ministry of Education's proposed harmonised timetable
    (October 2026). JAMB called these dates provisional until each exam body confirms them,
    so the titles say "proposed". Update them when JAMB, NECO and WAEC confirm.
*/
const wat = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);
const STARTER_EVENTS = [
  {
    title: 'Private universities admission deadline',
    kind: 'DEADLINE' as const,
    format: 'ONLINE' as const,
    startsAt: wat('2026-11-30', '23:59'),
    linkUrl: 'https://www.jamb.gov.ng',
    linkLabel: 'Open jamb.gov.ng',
    summary:
      "JAMB's deadline for private universities to finish 2026/2027 admissions. If a private university has offered you a place, check JAMB CAPS and accept or reject it before this date. Source: JAMB, 28 September 2026.",
    agenda: ['Check your admission status on JAMB CAPS', 'Accept or reject any offer before the deadline', "Never pay anyone to 'process' your admission"],
  },
  {
    title: 'Polytechnics and colleges of education admission deadline',
    kind: 'DEADLINE' as const,
    format: 'ONLINE' as const,
    startsAt: wat('2026-12-31', '23:59'),
    linkUrl: 'https://www.jamb.gov.ng',
    linkLabel: 'Open jamb.gov.ng',
    summary:
      "JAMB's deadline for polytechnics, colleges of education and other tertiary institutions to finish 2026/2027 admissions. Source: JAMB, 28 September 2026.",
    agenda: ['Check your admission status on JAMB CAPS', 'Accept or reject any offer before the deadline'],
  },
  {
    title: 'UTME 2027 (proposed dates)',
    kind: 'EXAM' as const,
    format: 'IN_PERSON' as const,
    startsAt: wat('2027-03-15', '08:30'),
    endsAt: wat('2027-03-25', '18:00'),
    venue: 'Your JAMB CBT centre',
    linkUrl: 'https://www.jamb.gov.ng',
    linkLabel: 'Open jamb.gov.ng',
    summary:
      "The Federal Ministry of Education's harmonised timetable proposes 15 to 25 March 2027 for the UTME. JAMB says the dates are provisional until confirmed, and registration dates are not out yet. We'll update this event when JAMB confirms.",
    agenda: [
      'Get your NIN ready, you need it to register',
      'Check the subject combination your course needs',
      'Watch jamb.gov.ng for the registration dates',
    ],
  },
  {
    title: 'NECO SSCE 2027 for school candidates (proposed dates)',
    kind: 'EXAM' as const,
    format: 'IN_PERSON' as const,
    startsAt: wat('2027-04-01', '09:00'),
    endsAt: wat('2027-05-14', '18:00'),
    venue: 'Your school',
    linkUrl: 'https://www.neco.gov.ng',
    linkLabel: 'Open neco.gov.ng',
    summary:
      "The Federal Ministry of Education's harmonised timetable proposes 1 April to 14 May 2027 for NECO's SSCE. These dates are provisional until NECO confirms its timetable.",
    agenda: ['Confirm your registration with your school', 'Get the official NECO timetable when it is released'],
  },
  {
    title: 'WASSCE 2027 for school candidates (proposed dates)',
    kind: 'EXAM' as const,
    format: 'IN_PERSON' as const,
    startsAt: wat('2027-05-11', '09:00'),
    endsAt: wat('2027-06-18', '18:00'),
    venue: 'Your school',
    linkUrl: 'https://www.waecnigeria.org',
    linkLabel: 'Open waecnigeria.org',
    summary:
      "The Federal Ministry of Education's harmonised timetable proposes 11 May to 18 June 2027 for WAEC's WASSCE for school candidates. These dates are provisional until WAEC confirms its timetable.",
    agenda: ['Confirm your registration with your school', 'Get the official WAEC timetable when it is released'],
  },
];

let prepared: Promise<void> | null = null;
export function ensureCommunity(): Promise<void> {
  if (!prepared) {
    prepared = (async () => {
      await ensureCommunityTables();
      for (const c of SEED_CHANNELS) {
        await db.communityChannel.upsert({ where: { slug: c.slug }, update: {}, create: c });
      }
      if (process.env.COMMUNITY_STARTER_EVENTS !== 'off' && (await db.communityEvent.count()) === 0) {
        await db.communityEvent.createMany({ data: STARTER_EVENTS });
      }
    })().catch((error) => {
      prepared = null;
      console.error('Could not prepare Community:', error);
    });
  }
  return prepared;
}

/* ----------------------------- Presenters ----------------------------- */

const authorSelect = { select: { id: true, firstname: true, lastname: true, role: true } } as const;

type MessageRow = {
  id: string;
  body: string;
  createdAt: Date;
  pinned: boolean;
  fromStaff: boolean;
  userId: string;
  user: { id: string; firstname: string; lastname: string; role: string } | null;
};

type ReactionSummary = { emoji: string; count: number; mine: boolean };

async function reactionsFor(messageIds: string[], userId: string) {
  const map: Record<string, ReactionSummary[]> = {};
  if (messageIds.length === 0) return map;
  const rows = await db.communityReaction.findMany({
    where: { messageId: { in: messageIds } },
    select: { messageId: true, emoji: true, userId: true },
  });
  for (const r of rows) {
    const list = (map[r.messageId] ||= []);
    let item = list.find((x) => x.emoji === r.emoji);
    if (!item) {
      item = { emoji: r.emoji, count: 0, mine: false };
      list.push(item);
    }
    item.count += 1;
    if (r.userId === userId) item.mine = true;
  }
  for (const id of Object.keys(map)) {
    map[id].sort((a, b) => REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji));
  }
  return map;
}

function presentMessage(m: MessageRow, me: AnyUser, reactions: ReactionSummary[] = []) {
  return {
    id: m.id,
    body: m.body,
    createdAt: m.createdAt,
    pinned: m.pinned,
    mine: m.userId === me.id,
    author: {
      name: displayName(m.user),
      initials: initialsOf(m.user),
      staff: m.fromStaff,
    },
    reactions,
  };
}

type EventRow = {
  id: string;
  title: string;
  kind: string;
  format: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  hostName: string | null;
  hostRole: string | null;
  summary: string;
  agenda: string[];
  platform: string | null;
  joinUrl: string | null;
  venue: string | null;
  address: string | null;
  mapUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  recordingUrl: string | null;
  _count?: { reminders: number };
  reminders?: { id: string }[];
};

export function presentEvent(e: EventRow) {
  return {
    id: e.id,
    title: e.title,
    kind: e.kind,
    format: e.format,
    status: e.status,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    hostName: e.hostName,
    hostRole: e.hostRole,
    summary: e.summary,
    agenda: e.agenda || [],
    platform: e.platform,
    joinUrl: e.joinUrl,
    venue: e.venue,
    address: e.address,
    mapUrl: e.mapUrl || (e.format === 'IN_PERSON' ? mapLinkFor(e.venue, e.address) : null),
    linkUrl: e.linkUrl,
    linkLabel: e.linkLabel,
    recordingUrl: e.recordingUrl,
    reminderCount: e._count?.reminders ?? 0,
    reminded: (e.reminders?.length ?? 0) > 0,
  };
}

/* ----------------------------- Who can post ----------------------------- */

async function profileOf(userId: string) {
  return db.communityProfile.findUnique({ where: { userId } });
}

function postBlock(user: AnyUser, profile: { mutedUntil: Date | null } | null) {
  if (isStaff(user)) return null;
  if (!user.emailVerified) return 'VERIFY_EMAIL' as const;
  if (profile?.mutedUntil && profile.mutedUntil > new Date()) return 'MUTED' as const;
  return null;
}

function blockMessage(block: 'VERIFY_EMAIL' | 'MUTED', mutedUntil?: Date | null) {
  if (block === 'VERIFY_EMAIL') {
    return fail(403, 'Verify your email to post in Community.', { code: 'VERIFY_EMAIL' });
  }
  const until = mutedUntil
    ? `${mutedUntil.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long' })} at ${mutedUntil.toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true })}`
    : '';
  return fail(403, `A moderator has paused your posting${until ? ` until ${until}` : ''}. You can still read.`, { code: 'MUTED' });
}

/* ----------------------------- Channels ----------------------------- */

export async function listChannelsService(user: AnyUser) {
  await ensureCommunity();
  const [channels, memberships, profile] = await Promise.all([
    db.communityChannel.findMany({
      where: { archived: false },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { memberships: true } } },
    }),
    db.communityMembership.findMany({ where: { userId: user.id } }),
    profileOf(user.id),
  ]);

  const data = await Promise.all(
    channels.map(async (c) => {
      const membership = memberships.find((m) => m.channelId === c.id);
      const [unread, recent, last] = await Promise.all([
        membership
          ? db.communityMessage.count({
              where: {
                channelId: c.id,
                createdAt: { gt: membership.lastReadAt },
                userId: { not: user.id },
                deletedAt: null,
                hidden: false,
              },
            })
          : Promise.resolve(0),
        db.communityMembership.findMany({
          where: { channelId: c.id },
          orderBy: { joinedAt: 'desc' },
          take: 3,
          include: { user: { select: { firstname: true, lastname: true } } },
        }),
        db.communityMessage.findFirst({
          where: { channelId: c.id, deletedAt: null, hidden: false },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        welcome: c.welcome,
        joined: !!membership,
        memberCount: c._count.memberships,
        unread,
        lastMessageAt: last?.createdAt ?? null,
        recentMembers: recent.map((m) => ({ initials: initialsOf(m.user) })),
      };
    })
  );

  const block = postBlock(user, profile);
  return ok({
    channels: data,
    me: {
      name: displayName(user),
      initials: initialsOf(user),
      staff: isStaff(user),
      rulesAccepted: isStaff(user) || !!profile?.rulesAcceptedAt,
      mutedUntil: profile?.mutedUntil && profile.mutedUntil > new Date() ? profile.mutedUntil : null,
      postBlock: block,
    },
  });
}

export async function acceptRulesService(user: AnyUser) {
  await ensureCommunity();
  await db.communityProfile.upsert({
    where: { userId: user.id },
    update: { rulesAcceptedAt: new Date() },
    create: { userId: user.id, rulesAcceptedAt: new Date() },
  });
  return ok({ rulesAccepted: true }, 'Thanks for agreeing to the Community rules');
}

async function channelBySlug(slug: unknown) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  return db.communityChannel.findFirst({ where: { slug, archived: false } });
}

export async function joinChannelService(user: AnyUser, slug: unknown) {
  await ensureCommunity();
  const channel = await channelBySlug(slug);
  if (!channel) return fail(404, 'Channel not found.');
  if (!isStaff(user)) {
    const profile = await profileOf(user.id);
    if (!profile?.rulesAcceptedAt) {
      return fail(409, 'Please read and agree to the Community rules first.', { code: 'RULES_REQUIRED' });
    }
  }
  await db.communityMembership.upsert({
    where: { channelId_userId: { channelId: channel.id, userId: user.id } },
    update: {},
    create: { channelId: channel.id, userId: user.id },
  });
  return ok({ joined: true }, `You joined #${channel.name}`);
}

export async function leaveChannelService(user: AnyUser, slug: unknown) {
  await ensureCommunity();
  const channel = await channelBySlug(slug);
  if (!channel) return fail(404, 'Channel not found.');
  await db.communityMembership.deleteMany({ where: { channelId: channel.id, userId: user.id } });
  return ok({ joined: false }, `You left #${channel.name}`);
}

const parseDate = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function channelMessagesService(
  user: AnyUser,
  slug: unknown,
  query: { before?: unknown; after?: unknown; limit?: unknown }
) {
  await ensureCommunity();
  const channel = await channelBySlug(slug);
  if (!channel) return fail(404, 'Channel not found.');

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const before = parseDate(query.before);
  const after = parseDate(query.after);
  const base = { channelId: channel.id, deletedAt: null, hidden: false };

  let rows: MessageRow[];
  let hasMore = false;
  if (after) {
    rows = await db.communityMessage.findMany({
      where: { ...base, createdAt: { gte: after } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { user: authorSelect },
    });
  } else {
    const desc = await db.communityMessage.findMany({
      where: { ...base, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: { user: authorSelect },
    });
    hasMore = desc.length > limit;
    rows = desc.slice(0, limit).reverse();
  }

  // Reactions for what was returned plus the latest messages, so counts stay fresh while polling.
  const latest = after
    ? await db.communityMessage.findMany({
        where: base,
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      })
    : [];
  const ids = Array.from(new Set([...rows.map((r) => r.id), ...latest.map((r) => r.id)]));
  const found = await reactionsFor(ids, user.id);
  // Every message checked is listed, with [] when it has none, so removed reactions disappear too.
  const reactions: Record<string, ReactionSummary[]> = {};
  for (const id of ids) reactions[id] = found[id] || [];

  // Messages removed by their author or a moderator in the last week, so open screens drop them.
  const removed = after
    ? (
        await db.communityMessage.findMany({
          where: {
            channelId: channel.id,
            OR: [{ deletedAt: { not: null } }, { hidden: true }],
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
          },
          select: { id: true },
          take: 200,
        })
      ).map((r) => r.id)
    : [];

  const pinned =
    !after && !before
      ? await db.communityMessage.findMany({
          where: { ...base, pinned: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { user: authorSelect },
        })
      : [];

  const membership = await db.communityMembership.findUnique({
    where: { channelId_userId: { channelId: channel.id, userId: user.id } },
  });
  if (membership) {
    await db.communityMembership.update({ where: { id: membership.id }, data: { lastReadAt: new Date() } });
  }

  return ok({
    channel: { id: channel.id, slug: channel.slug, name: channel.name, description: channel.description, welcome: channel.welcome },
    joined: !!membership,
    messages: rows.map((m) => presentMessage(m, user, reactions[m.id])),
    hasMore,
    reactions,
    removed,
    pinned: pinned.map((m) => presentMessage(m, user)),
    serverTime: new Date(),
  });
}

export async function postChannelMessageService(user: AnyUser, slug: unknown, rawBody: unknown) {
  await ensureCommunity();
  const channel = await channelBySlug(slug);
  if (!channel) return fail(404, 'Channel not found.');
  const staff = isStaff(user);

  if (!staff) {
    const membership = await db.communityMembership.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId: user.id } },
    });
    if (!membership) return fail(409, `Join #${channel.name} to post.`, { code: 'JOIN_REQUIRED' });
    const profile = await profileOf(user.id);
    const block = postBlock(user, profile);
    if (block) return blockMessage(block, profile?.mutedUntil);
  }

  const { body, error } = cleanBody(rawBody);
  if (!body) return fail(400, error || 'Write a message first.', { code: 'EMPTY' });

  if (!staff) {
    const problem = checkStudentMessage(body);
    if (problem) return fail(400, problem, { code: 'NOT_ALLOWED' });
    const limit = rateLimit(`post:${user.id}`, { gapMs: 3000, max: 20, windowMs: 10 * 60 * 1000 });
    if (!limit.ok) return fail(429, limit.message, { code: 'TOO_FAST' });
  }

  const row = await db.communityMessage.create({
    data: { channelId: channel.id, userId: user.id, body, fromStaff: staff },
    include: { user: authorSelect },
  });
  await db.communityMembership.updateMany({
    where: { channelId: channel.id, userId: user.id },
    data: { lastReadAt: new Date() },
  });
  return ok(presentMessage(row, user, []), 'Sent', 201);
}

async function visibleMessage(id: unknown) {
  if (typeof id !== 'string' || id.length > 64) return null;
  return db.communityMessage.findFirst({ where: { id, deletedAt: null } });
}

export async function deleteOwnMessageService(user: AnyUser, id: unknown) {
  await ensureCommunity();
  const message = await visibleMessage(id);
  if (!message) return fail(404, 'Message not found.');
  if (message.userId !== user.id && !isStaff(user)) return fail(403, 'You can only delete your own messages.');
  await db.communityMessage.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  return ok({ id: message.id }, 'Message deleted');
}

export async function toggleReactionService(user: AnyUser, id: unknown, emoji: unknown) {
  await ensureCommunity();
  if (typeof emoji !== 'string' || !REACTIONS.includes(emoji)) return fail(400, 'Pick one of the reactions.');
  const message = await visibleMessage(id);
  if (!message || message.hidden) return fail(404, 'Message not found.');
  if (!isStaff(user)) {
    const membership = await db.communityMembership.findUnique({
      where: { channelId_userId: { channelId: message.channelId, userId: user.id } },
    });
    if (!membership) return fail(409, 'Join the channel to react.', { code: 'JOIN_REQUIRED' });
    const limit = rateLimit(`react:${user.id}`, { gapMs: 0, max: 120, windowMs: 10 * 60 * 1000 });
    if (!limit.ok) return fail(429, limit.message, { code: 'TOO_FAST' });
  }
  const existing = await db.communityReaction.findUnique({
    where: { messageId_userId_emoji: { messageId: message.id, userId: user.id, emoji } },
  });
  if (existing) {
    await db.communityReaction.delete({ where: { id: existing.id } });
  } else {
    await db.communityReaction.create({ data: { messageId: message.id, userId: user.id, emoji } }).catch((e: any) => {
      if (e?.code !== 'P2002') throw e;
    });
  }
  const map = await reactionsFor([message.id], user.id);
  return ok({ id: message.id, reactions: map[message.id] || [] });
}

export async function reportMessageService(user: AnyUser, id: unknown, reason: unknown) {
  await ensureCommunity();
  const message = await visibleMessage(id);
  if (!message) return fail(404, 'Message not found.');
  if (message.userId === user.id) return fail(400, "You can't report your own message.");
  const limit = rateLimit(`report:${user.id}`, { gapMs: 1000, max: 20, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) return fail(429, limit.message, { code: 'TOO_FAST' });

  const text = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  try {
    await db.communityReport.create({ data: { messageId: message.id, reporterId: user.id, reason: text || null } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
  const open = await db.communityReport.count({ where: { messageId: message.id, resolvedAt: null } });
  if (open >= REPORTS_TO_HIDE && !message.fromStaff && !message.hidden) {
    await db.communityMessage.update({ where: { id: message.id }, data: { hidden: true } });
  }
  return ok({ reported: true }, 'Thanks. A moderator will look at this message.');
}

/* ----------------------------- AlignTraits team ----------------------------- */

type TeamRow = {
  id: string;
  body: string;
  createdAt: Date;
  fromStaff: boolean;
  sender: { firstname: string; lastname: string } | null;
};

export const presentTeamMessage = (m: TeamRow) => ({
  id: m.id,
  body: m.body,
  createdAt: m.createdAt,
  fromStaff: m.fromStaff,
  author: m.fromStaff
    ? { name: m.sender ? `${m.sender.firstname} · AlignTraits team` : 'AlignTraits team', initials: 'AT' }
    : { name: displayName(m.sender), initials: initialsOf(m.sender) },
});

export async function teamMessagesService(user: AnyUser, query: { after?: unknown }) {
  await ensureCommunity();
  const thread = await db.communityTeamThread.findUnique({ where: { userId: user.id } });
  if (!thread) return ok({ messages: [], serverTime: new Date() });
  const after = parseDate(query.after);
  const rows = after
    ? await db.communityTeamMessage.findMany({
        where: { threadId: thread.id, createdAt: { gte: after } },
        orderBy: { createdAt: 'asc' },
        take: 200,
        include: { sender: { select: { firstname: true, lastname: true } } },
      })
    : (
        await db.communityTeamMessage.findMany({
          where: { threadId: thread.id },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { sender: { select: { firstname: true, lastname: true } } },
        })
      ).reverse();
  await db.communityTeamThread.update({ where: { id: thread.id }, data: { studentReadAt: new Date() } });
  return ok({ messages: rows.map(presentTeamMessage), serverTime: new Date() });
}

export async function postTeamMessageService(user: AnyUser, rawBody: unknown) {
  await ensureCommunity();
  const { body, error } = cleanBody(rawBody);
  if (!body) return fail(400, error || 'Write a message first.', { code: 'EMPTY' });
  const limit = rateLimit(`team:${user.id}`, { gapMs: 2000, max: 15, windowMs: 10 * 60 * 1000 });
  if (!limit.ok) return fail(429, limit.message, { code: 'TOO_FAST' });

  const now = new Date();
  const thread = await db.communityTeamThread.upsert({
    where: { userId: user.id },
    update: { lastMessageAt: now, studentReadAt: now },
    create: { userId: user.id, lastMessageAt: now, studentReadAt: now },
  });
  const row = await db.communityTeamMessage.create({
    data: { threadId: thread.id, senderId: user.id, fromStaff: false, body },
    include: { sender: { select: { firstname: true, lastname: true } } },
  });
  return ok(presentTeamMessage(row), 'Sent to the AlignTraits team', 201);
}

/* ----------------------------- Events ----------------------------- */

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // West Africa Time, UTC+1 all year

/** Monday 00:00 to next Monday 00:00 in Lagos, for the week that contains `now`. */
export function lagosWeek(now = new Date()) {
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day);
  const start = new Date(startLocal - LAGOS_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * 24 * 3600 * 1000) };
}

const eventInclude = (userId: string) => ({
  _count: { select: { reminders: true } },
  reminders: { where: { userId }, select: { id: true } },
});

export async function listEventsService(user: AnyUser, query: { from?: unknown; to?: unknown }) {
  await ensureCommunity();
  const from = parseDate(query.from) || new Date(Date.now() - 200 * 24 * 3600 * 1000);
  const to = parseDate(query.to) || new Date(Date.now() + 400 * 24 * 3600 * 1000);
  const rows = await db.communityEvent.findMany({
    where: { startsAt: { gte: from, lt: to } },
    orderBy: { startsAt: 'asc' },
    take: 300,
    include: eventInclude(user.id),
  });
  return ok({ events: rows.map(presentEvent), serverTime: new Date() });
}

export async function getEventService(user: AnyUser, id: unknown) {
  await ensureCommunity();
  if (typeof id !== 'string' || id.length > 64) return fail(404, 'Event not found.');
  const row = await db.communityEvent.findUnique({ where: { id }, include: eventInclude(user.id) });
  if (!row) return fail(404, 'Event not found.');
  return ok(presentEvent(row));
}

const eventEnd = (e: { startsAt: Date; endsAt: Date | null }) => e.endsAt || e.startsAt;

export async function setReminderService(user: AnyUser, id: unknown, on: boolean) {
  await ensureCommunity();
  if (typeof id !== 'string' || id.length > 64) return fail(404, 'Event not found.');
  const event = await db.communityEvent.findUnique({ where: { id } });
  if (!event) return fail(404, 'Event not found.');
  if (on) {
    if (event.status === 'CANCELLED') return fail(400, 'This event was cancelled.');
    if (eventEnd(event) < new Date()) return fail(400, 'This event has already ended.');
    await db.communityEventReminder.upsert({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
      update: {},
      create: { eventId: event.id, userId: user.id },
    });
  } else {
    await db.communityEventReminder.deleteMany({ where: { eventId: event.id, userId: user.id } });
  }
  const reminderCount = await db.communityEventReminder.count({ where: { eventId: event.id } });
  return ok(
    { reminded: on, reminderCount },
    on ? "Reminder set. We'll email you a day before and an hour before." : 'Reminder removed'
  );
}

/* ----------------------------- Summary (menu badge) ----------------------------- */

export async function communitySummaryService(user: AnyUser) {
  await ensureCommunity();
  const memberships = await db.communityMembership.findMany({ where: { userId: user.id } });
  const counts = await Promise.all(
    memberships.map((m) =>
      db.communityMessage.count({
        where: { channelId: m.channelId, createdAt: { gt: m.lastReadAt }, userId: { not: user.id }, deletedAt: null, hidden: false },
      })
    )
  );
  const channels = counts.reduce((a, b) => a + b, 0);

  const thread = await db.communityTeamThread.findUnique({ where: { userId: user.id } });
  const team = thread
    ? await db.communityTeamMessage.count({ where: { threadId: thread.id, fromStaff: true, createdAt: { gt: thread.studentReadAt } } })
    : 0;

  const { start, end } = lagosWeek();
  const now = new Date();
  const [eventsThisWeek, next] = await Promise.all([
    db.communityEvent.count({ where: { status: 'SCHEDULED', startsAt: { gte: start, lt: end } } }),
    db.communityEvent.findFirst({
      where: { status: 'SCHEDULED', OR: [{ startsAt: { gte: now } }, { endsAt: { gte: now } }] },
      orderBy: { startsAt: 'asc' },
      include: eventInclude(user.id),
    }),
  ]);

  return ok({
    unread: { channels, team, total: channels + team },
    eventsThisWeek,
    nextEvent: next ? presentEvent(next) : null,
  });
}
