import { db } from '../config/db';
import { sendMail } from './mailServices';
import { ensureCommunity } from './communityService';
import { mapLinkFor } from './communityRules';

/*
  Community emails: event reminders (a day before and an hour before), event
  cancellations, and "the AlignTraits team replied" notices.
  All times are shown in West Africa Time (Lagos).
*/

const TZ = 'Africa/Lagos';
const site = () => (process.env.WEBSITE_URL || 'https://aligntraits.com').replace(/\/+$/, '');
export const eventPageUrl = (id: string) => `${site()}/dashboard/community/events?event=${encodeURIComponent(id)}`;

const dayLabel = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
const timeLabel = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
const lagosDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD

type EventForMail = {
  id: string;
  title: string;
  kind: string;
  format: string;
  startsAt: Date;
  endsAt: Date | null;
  platform: string | null;
  joinUrl: string | null;
  venue: string | null;
  address: string | null;
  mapUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
};

function whenText(e: EventForMail) {
  const day = dayLabel(e.startsAt);
  if (e.kind === 'EXAM') {
    return e.endsAt && lagosDate(e.endsAt) !== lagosDate(e.startsAt) ? `${day} to ${dayLabel(e.endsAt)}` : day;
  }
  if (e.kind === 'DEADLINE') return `${day}, closes at ${timeLabel(e.startsAt)} WAT`;
  return `${day}, ${timeLabel(e.startsAt)}${e.endsAt ? ` to ${timeLabel(e.endsAt)}` : ''} WAT`;
}

function whereText(e: EventForMail) {
  if (e.kind === 'EXAM') return e.venue || 'Your centre and paper times are on your exam slip or timetable';
  if (e.kind === 'DEADLINE' && !e.venue && !e.address) return e.linkUrl ? `Online: ${e.linkLabel || e.linkUrl}` : 'Deadline';
  if (e.format === 'ONLINE') return `Online, ${e.platform || 'AlignTraits Live'}`;
  return [e.venue, e.address].filter(Boolean).join(', ') || 'In person';
}

const relativeDay = (e: EventForMail, now: Date) => {
  const today = lagosDate(now);
  const tomorrow = lagosDate(new Date(now.getTime() + 24 * 3600 * 1000));
  const d = lagosDate(e.startsAt);
  if (d === today) return 'today';
  if (d === tomorrow) return 'tomorrow';
  return `on ${dayLabel(e.startsAt)}`;
};

function primaryAction(e: EventForMail, stage: 'day' | 'hour') {
  if ((e.kind === 'DEADLINE' || e.kind === 'EXAM') && e.linkUrl) return { label: e.linkLabel || 'Open the official site', url: e.linkUrl };
  if (e.format === 'ONLINE' && stage === 'hour' && e.joinUrl) return { label: 'Join session', url: e.joinUrl };
  if (e.format === 'IN_PERSON') {
    const map = e.mapUrl || mapLinkFor(e.venue, e.address);
    if (map) return { label: 'Get directions', url: map };
  }
  return { label: 'See event details', url: eventPageUrl(e.id) };
}

export async function sendReminderEmail(
  to: { email: string; firstname: string },
  e: EventForMail,
  stage: 'day' | 'hour',
  now = new Date()
) {
  const deadline = e.kind === 'DEADLINE';
  const exam = e.kind === 'EXAM';
  const when = relativeDay(e, now);
  const time = timeLabel(e.startsAt);
  const headline = exam
    ? `${e.title} starts ${when}`
    :
    stage === 'hour'
      ? deadline
        ? `${e.title} closes in about an hour`
        : `${e.title} starts in about an hour`
      : deadline
        ? `${e.title} closes ${when} at ${time}`
        : `${e.title} is ${when} at ${time}`;
  const subject = exam
    ? `${when === 'tomorrow' ? 'Tomorrow' : when === 'today' ? 'Today' : 'Coming up'}: ${e.title} starts`
    : stage === 'hour'
      ? `${deadline ? 'Closing soon' : 'Starting soon'}: ${e.title}`
      : `${when === 'tomorrow' ? 'Tomorrow' : when === 'today' ? 'Today' : 'Coming up'}: ${e.title}`;
  const action = primaryAction(e, stage);
  const lines = exam
    ? ['Check your exam slip or timetable for your papers, pack what you need tonight, and get to your centre early.']
    : stage === 'hour' && e.format === 'ONLINE' && !deadline
      ? ['The room opens 10 minutes before the start time. Join from your phone or computer.']
      : deadline
        ? ["Here's your reminder. Finish early so a slow network doesn't catch you at the last minute."]
        : ["Here's the reminder you asked for."];

  return sendMail({
    recipients: [to.email],
    subject,
    templateName: 'communityNotice',
    templateInfo: {
      label: 'AlignTraits Community',
      name: to.firstname || 'there',
      headline,
      lines,
      details: [
        { label: 'When', value: whenText(e) },
        { label: 'Where', value: whereText(e) },
      ],
      ctaLabel: action.label,
      ctaUrl: action.url,
      secondaryLabel: action.url === eventPageUrl(e.id) ? '' : 'See event details',
      secondaryUrl: action.url === eventPageUrl(e.id) ? '' : eventPageUrl(e.id),
      footer: 'You are getting this email because you tapped Remind me on AlignTraits. You can turn it off on the event page.',
    },
  });
}

export async function sendCancelledEmail(to: { email: string; firstname: string }, e: EventForMail) {
  return sendMail({
    recipients: [to.email],
    subject: `Cancelled: ${e.title}`,
    templateName: 'communityNotice',
    templateInfo: {
      label: 'AlignTraits Community',
      name: to.firstname || 'there',
      headline: `${e.title} has been cancelled`,
      lines: ["Sorry for the change. You don't need to do anything. We'll post new dates in Community."],
      details: [
        { label: 'Was planned for', value: whenText(e) },
        { label: 'Where', value: whereText(e) },
      ],
      ctaLabel: 'See other events',
      ctaUrl: `${site()}/dashboard/community/events`,
      secondaryLabel: '',
      secondaryUrl: '',
      footer: 'You are getting this email because you set a reminder for this event on AlignTraits.',
    },
  });
}

export async function sendTeamReplyEmail(to: { email: string; firstname: string }) {
  return sendMail({
    recipients: [to.email],
    subject: 'The AlignTraits team replied to you',
    templateName: 'communityNotice',
    templateInfo: {
      label: 'AlignTraits Community',
      name: to.firstname || 'there',
      headline: 'You have a reply from the AlignTraits team',
      lines: ['Open Community to read it and reply.'],
      details: [],
      ctaLabel: 'Read the reply',
      ctaUrl: `${site()}/dashboard/community/team`,
      secondaryLabel: '',
      secondaryUrl: '',
      footer: 'You are getting this email because you messaged the AlignTraits team on aligntraits.com.',
    },
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
  Sends due reminders. Runs every few minutes.
  - Day email: the event starts within 24 hours but more than 2 hours from now.
  - Hour email: the event starts within the next 65 minutes.
  Each email is claimed in the database before it is sent, so it goes out once
  even if the job overlaps itself.
*/
export async function runCommunityReminders(now = new Date()) {
  await ensureCommunity();
  const H = 3600 * 1000;
  let sent = 0;

  const stages: Array<{ stage: 'day' | 'hour'; field: 'dayEmailAt' | 'hourEmailAt'; from: Date; to: Date }> = [
    { stage: 'hour', field: 'hourEmailAt', from: now, to: new Date(now.getTime() + 65 * 60 * 1000) },
    { stage: 'day', field: 'dayEmailAt', from: new Date(now.getTime() + 2 * H), to: new Date(now.getTime() + 24 * H) },
  ];

  for (const s of stages) {
    const due = await db.communityEventReminder.findMany({
      where: {
        [s.field]: null,
        // Exams run over days, so they get the day-before email only.
        event: { status: 'SCHEDULED', startsAt: { gt: s.from, lte: s.to }, ...(s.stage === 'hour' ? { kind: { not: 'EXAM' as const } } : {}) },
      },
      take: 200,
      include: { event: true, user: { select: { email: true, firstname: true } } },
    });
    for (const r of due) {
      const claimed = await db.communityEventReminder.updateMany({
        where: { id: r.id, [s.field]: null },
        data: { [s.field]: new Date(), ...(s.stage === 'hour' ? { dayEmailAt: r.dayEmailAt ?? new Date() } : {}) },
      });
      if (claimed.count !== 1) continue;
      try {
        await sendReminderEmail(r.user, r.event, s.stage, now);
        sent += 1;
      } catch (error) {
        console.error('Community reminder email failed:', error);
      }
      await pause(550); // stay under the email provider's rate limit
    }
  }
  return sent;
}

export async function notifyEventCancelled(eventId: string) {
  const event = await db.communityEvent.findUnique({
    where: { id: eventId },
    include: { reminders: { include: { user: { select: { email: true, firstname: true } } } } },
  });
  if (!event) return 0;
  let sent = 0;
  for (const r of event.reminders) {
    try {
      await sendCancelledEmail(r.user, event);
      sent += 1;
    } catch (error) {
      console.error('Community cancellation email failed:', error);
    }
    await pause(550);
  }
  return sent;
}
