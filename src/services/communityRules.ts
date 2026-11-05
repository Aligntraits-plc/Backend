/*
  Community safety rules and small helpers shared by the student and admin services.

  Most AlignTraits students are under 18, so channel messages from students are
  checked before they are saved:
  - no phone numbers or email addresses (keeps contact details private and stops
    people pulling students into private chats),
  - links only to trusted sites (stops scams such as "pay me to speed up your slip").
  Staff messages skip these checks. Messages to the AlignTraits team are private to
  the team, so they are not filtered either.
*/

export const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN'];
export const isStaff = (user: { role?: string | null } | null | undefined) =>
  !!user && STAFF_ROLES.includes(String(user.role));

export const MAX_MESSAGE_LENGTH = 2000;
export const REACTIONS = ['👍', '🙏', '✅', '😂', '🎉', '👀'];
export const REPORTS_TO_HIDE = 3;

// Trusted link domains. A domain also covers its subdomains, so "gov.ng" covers
// jamb.gov.ng and neco.gov.ng, and "edu.ng" covers every Nigerian university site.
// Add more without a code change with COMMUNITY_LINK_DOMAINS=example.org,other.ng
const DEFAULT_LINK_DOMAINS = ['gov.ng', 'edu.ng', 'waec.org.ng', 'waecdirect.org', 'aligntraits.com'];
export const allowedLinkDomains = (): string[] => {
  const extra = (process.env.COMMUNITY_LINK_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return [...DEFAULT_LINK_DOMAINS, ...extra];
};

const TLDS =
  'com|ng|org|net|io|me|ly|co|info|xyz|app|link|gl|gd|to|site|online|edu|gov|uk|us|biz|live|tv|cc|ws|top|click|club|store|shop';
const URL_PATTERN = new RegExp(
  `((?:https?:\\/\\/|www\\.)[^\\s<>()]+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:\\/[^\\s<>()]*)?)`,
  'gi'
);
const EMAIL_PATTERN = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{8,}\d/g;

export const hostOf = (raw: string): string | null => {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export const isAllowedHost = (host: string | null) => {
  if (!host) return false;
  return allowedLinkDomains().some((d) => host === d || host.endsWith(`.${d}`));
};

/** Returns a friendly reason when a student's channel message breaks a safety rule. */
export function checkStudentMessage(body: string): string | null {
  if (EMAIL_PATTERN.test(body)) {
    return "For your safety, email addresses can't be posted in channels. Message the AlignTraits team if you need help.";
  }
  const phones = body.match(PHONE_CANDIDATE) || [];
  if (phones.some((p) => {
    const digits = p.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  })) {
    return "For your safety, phone numbers can't be posted in channels. Message the AlignTraits team if you need help.";
  }
  const links = body.match(URL_PATTERN) || [];
  const blocked = links.find((l) => !isAllowedHost(hostOf(l.replace(/[.,!?;:]+$/, ''))));
  if (blocked) {
    return 'Links can only go to official sites, like jamb.gov.ng, waec.org.ng or a university .edu.ng site.';
  }
  return null;
}

/** Trims, limits blank lines and checks the length. Returns the cleaned text or an error. */
export function cleanBody(raw: unknown): { body?: string; error?: string } {
  if (typeof raw !== 'string') return { error: 'Write a message first.' };
  const body = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!body) return { error: 'Write a message first.' };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.` };
  }
  return { body };
}

/* Simple in-memory rate limits (per server). Enough to stop flooding. */
type Bucket = { last: number; times: number[] };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, { gapMs, max, windowMs }: { gapMs: number; max: number; windowMs: number }) {
  const now = Date.now();
  const b = buckets.get(key) || { last: 0, times: [] };
  b.times = b.times.filter((t) => now - t < windowMs);
  if (now - b.last < gapMs) {
    return { ok: false, message: 'Slow down a little, then send again.' };
  }
  if (b.times.length >= max) {
    return { ok: false, message: "You've sent a lot of messages. Take a short break and try again in a few minutes." };
  }
  b.last = now;
  b.times.push(now);
  buckets.set(key, b);
  if (buckets.size > 20000) buckets.clear();
  return { ok: true as const };
}

/* People are shown by first name and last initial ("Tobi A."), with initials instead of photos. */
export const displayName = (u: { firstname?: string | null; lastname?: string | null } | null | undefined) => {
  const first = (u?.firstname || '').trim() || 'Student';
  const last = (u?.lastname || '').trim();
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
};

export const initialsOf = (u: { firstname?: string | null; lastname?: string | null } | null | undefined) => {
  const a = (u?.firstname || '').trim()[0] || 'S';
  const b = (u?.lastname || '').trim()[0] || '';
  return (a + b).toUpperCase();
};

export const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  status,
  message,
  errors: [{ message }],
  ...extra,
});

export const ok = <T>(data: T, message = 'OK', status = 200) => ({ ok: true, status, message, data });

export const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

export const mapLinkFor = (venue?: string | null, address?: string | null) => {
  const q = [venue, address].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
};
