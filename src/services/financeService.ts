/*
  Financing (Profile and settings): the family's yearly budget, how many of the
  student's matches fit it, scholarships to follow, and the student loan note.

  Everything shown is worked out from saved data:
  - "N of M matches fit" compares the budget with each match's year one cost
    (tuition plus acceptance fee), the same figure the dashboard shows.
  - A scholarship is marked "Matches your profile" only when every rule it has
    (state of origin, class arm, gender) is met by what the student has saved.
*/
import { db } from '../config/db';
import { ensureSettingsTables } from './settingsTables';
import { fail, ok } from './communityRules';
import { sendMail } from './mailServices';
import { siteUrl } from './rolesMail';
import { studentInsights } from './studentInsights';
import { ARMS } from './studentSettingsService';
import { NIGERIAN_STATES } from './formsService';

type AnyUser = { id: string; role: string; firstname: string; lastname: string; email: string };

export const BUDGET = { min: 100000, max: 5000000, step: 50000 };
export const COVERS = [
  { key: 'tuition', label: 'Tuition and fees' },
  { key: 'hostel', label: 'Hostel' },
  { key: 'feeding', label: 'Feeding' },
  { key: 'books', label: 'Books and laptop' },
];
const WHO = ['PARENTS', 'SCHOLARSHIP', 'BOTH'];
const LEVELS = ['ANY', 'ENTRY', 'FROM_200'];
const DAY = 24 * 3600 * 1000;

const list = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/*
  The starting list: the scholarships already checked for the public Scholarships
  page (October 2026). Added once, when the table is empty. After that the team
  edits them in Admin > Scholarships. Closing dates are left empty on purpose:
  a date is only shown once someone has confirmed it on the official page.
*/
const STARTER = [
  { slug: 'lagos-state-scholarship', name: 'Lagos State Scholarship Award', funder: 'Lagos State Scholarship Board', amountText: 'A yearly award. Amount not published', windowText: 'Usually opens January to March', link: 'https://www.lagosscholarship.org/', forText: 'Lagos State indigenes', level: 'ANY', states: ['Lagos'] },
  { slug: 'lagos-state-bursary', name: 'Lagos State Bursary Award', funder: 'Lagos State Scholarship Board', amountText: 'A yearly bursary for upkeep', windowText: 'Usually opens January to March', link: 'https://www.lagosscholarship.org/', forText: 'Lagos State indigenes', level: 'ANY', states: ['Lagos'] },
  { slug: 'jim-ovia-foundation', name: 'Jim Ovia Foundation Scholarship', funder: 'Jim Ovia Foundation', amountText: '₦250,000 a year', windowText: 'Usually opens late November', link: 'https://jimoviafoundation.org/FAQ/', forText: 'Admitted undergraduates, any course', level: 'ANY' },
  { slug: 'waaw-foundation', name: 'WAAW Foundation Undergraduate Scholarship', funder: 'WAAW Foundation', amountText: 'US$500, paid once in naira', windowText: 'Expected November 2026', link: 'https://waawfoundation.org/waaw-foundation-2025-2026-undergraduate-scholarship/', forText: 'Women studying science and technology courses', level: 'ANY', arms: ['Science', 'Technical'], gender: 'FEMALE' },
  { slug: 'oando-jv-national', name: 'NEPL/OERNL JV Tertiary Scholarship', funder: 'Oando and its joint venture partners', amountText: 'A yearly scholarship. Amount not published', windowText: 'Usually opens in March', link: 'https://candidate.scholastica.ng/schemes/oandoscholarship2026', forText: '100 level engineering, geosciences or agriculture', level: 'ENTRY', arms: ['Science', 'Technical'] },
  { slug: 'chevron-jv-standard', name: 'NNPC Ltd/Chevron JV National University Scholarship', funder: 'Chevron Nigeria and NNPC', amountText: 'A yearly grant. Amount not published', windowText: 'Usually opens mid-year', link: 'https://candidate.scholastica.ng/schemes/2026CNLawards', forText: '200 level students with a CGPA of 3.5 or above', level: 'FROM_200' },
  { slug: 'renaissance-jv-national', name: 'NNPC/Renaissance JV University Scholarship', funder: 'NNPC/Renaissance joint venture', amountText: 'A yearly grant. Amount not published', windowText: 'Usually opens April to May', link: 'https://candidate.scholastica.ng/schemes/NNPCRENAISSANCEJV2026', forText: '200 level students from any state', level: 'FROM_200' },
  { slug: 'pau-tuition-aid', name: 'Pan-Atlantic University Tuition Fee Aid', funder: 'Pan-Atlantic University', amountText: 'Almost full or part tuition, for students with proven need', windowText: 'Usually May to June, alongside admission', link: 'https://pau.edu.ng/admissions/undergrad-2/aid/', forText: 'Pan-Atlantic University students', level: 'ANY', schoolName: 'Pan-Atlantic University' },
  { slug: 'abuad-agriculture', name: 'ABUAD Agriculture Tuition Reduction', funder: 'Afe Babalola University, Ado-Ekiti', amountText: 'Half tuition for all five years', windowText: 'Applied when you are admitted to B.Agric', link: 'https://www.abuad.edu.ng/abuad-special-privileges-for-parents-and-staff/', forText: 'ABUAD B.Agric students', level: 'ANY', schoolName: 'Afe Babalola University' },
];

let seeded: Promise<void> | null = null;
async function ensureScholarships() {
  await ensureSettingsTables();
  if (!seeded) {
    seeded = (async () => {
      if (process.env.SCHOLARSHIP_STARTER === 'off') return;
      if ((await db.scholarship.count()) > 0) return;
      for (const s of STARTER) {
        const { states, arms, ...rest } = s as any;
        await db.scholarship.upsert({
          where: { slug: s.slug },
          update: {},
          create: { ...rest, states: states ? JSON.stringify(states) : null, arms: arms ? JSON.stringify(arms) : null, checkedAt: new Date('2026-10-28T00:00:00.000Z') },
        });
      }
    })().catch((error) => {
      seeded = null;
      console.error('Could not add the starter scholarships:', error);
    });
  }
  return seeded;
}

const shortDate = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }).format(d);

type Profile = { stateOfOrigin: string | null; classArm: string | null; gender: string | null; schools: string[] };
function badgeFor(s: any, p: Profile) {
  if (s.level === 'FROM_200') return { tone: 'neutral', label: 'From 200 level' };
  if (s.schoolName) {
    const inMatches = p.schools.some((x) => x.toLowerCase().includes(String(s.schoolName).toLowerCase()));
    return inMatches ? { tone: 'match', label: 'In your matches' } : { tone: 'neutral', label: `${s.schoolName} only` };
  }
  const states = list(s.states);
  const arms = list(s.arms);
  const rules: (boolean | null)[] = [];
  if (states.length) rules.push(p.stateOfOrigin ? states.includes(p.stateOfOrigin) : null);
  if (arms.length) rules.push(p.classArm ? arms.includes(p.classArm) : null);
  if (s.gender) rules.push(p.gender ? p.gender === s.gender : null);
  if (rules.some((r) => r === false)) return { tone: 'neutral', label: s.forText };
  if (rules.some((r) => r === null)) return { tone: 'neutral', label: s.forText };
  return { tone: 'match', label: 'Matches your profile' };
}

export async function getFinanceService(me: AnyUser) {
  await ensureScholarships();
  const [user, settings, insights, scholarships, follows] = await Promise.all([
    db.user.findUnique({ where: { id: me.id }, select: { gender: true } }),
    db.studentSettings.findUnique({ where: { userId: me.id } }),
    studentInsights(me.id),
    db.scholarship.findMany({ where: { active: true }, orderBy: [{ closesAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] }),
    db.scholarshipFollow.findMany({ where: { userId: me.id }, select: { scholarshipId: true } }),
  ]);

  // Matches with a known year one cost in naira. One line per school and course.
  const priced = insights.matches.filter((m) => m.tier && m.yearOneCost !== null && (!m.currency || m.currency === 'NGN'));
  const budget = settings?.budgetYearly ?? null;
  const over = budget === null ? [] : priced.filter((m) => (m.yearOneCost as number) > budget).sort((a, b) => (a.yearOneCost as number) - (b.yearOneCost as number));
  const schoolCount = (name: string) => over.filter((m) => m.school === name).length;
  const privates = Array.from(new Set(priced.filter((m) => m.schoolType === 'PRIVATE_UNIVERSITY').map((m) => m.school)));
  const publics = Array.from(new Set(priced.filter((m) => m.schoolType && m.schoolType !== 'PRIVATE_UNIVERSITY').map((m) => m.school)));

  const profile: Profile = {
    stateOfOrigin: settings?.stateOfOrigin || null,
    classArm: settings?.classArm || null,
    gender: user?.gender || null,
    schools: Array.from(new Set(insights.matches.map((m) => m.school))),
  };
  const followed = new Set(follows.map((f) => f.scholarshipId));
  const now = Date.now();

  return ok({
    budget: { value: budget, ...BUDGET },
    fit: {
      total: priced.length,
      fits: budget === null ? null : priced.length - over.length,
      over: over.slice(0, 4).map((m) => ({ label: schoolCount(m.school) > 1 ? `${m.course} at ${m.school}` : m.school, cost: naira(m.yearOneCost as number) })),
      moreOver: Math.max(0, over.length - 4),
      hasMatches: insights.matches.some((m) => m.tier),
    },
    covers: { options: COVERS, chosen: list(settings?.budgetCovers).filter((k) => COVERS.some((c) => c.key === k)) },
    whoPays: settings?.whoPays && WHO.includes(settings.whoPays) ? settings.whoPays : null,
    scholarships: scholarships
      .filter((s) => !s.closesAt || s.closesAt.getTime() > now - DAY)
      .map((s) => ({
        id: s.id,
        name: s.name,
        funder: s.funder,
        amount: s.amountText,
        when: s.closesAt ? `Applications close ${shortDate(s.closesAt)}` : s.windowText,
        hasDate: !!s.closesAt,
        link: s.link,
        badge: badgeFor(s, profile),
        following: followed.has(s.id),
      })),
    missingForMatching: [!profile.stateOfOrigin && 'state of origin', !profile.classArm && 'class arm'].filter(Boolean),
    nelfund: { on: !!settings?.wantsNelfund, privateSchools: privates.slice(0, 4), morePrivate: Math.max(0, privates.length - 4), publicCount: publics.length },
  });
}

export async function saveFinanceService(me: AnyUser, body: Record<string, unknown>) {
  await ensureSettingsTables();
  const errors: Record<string, string> = {};
  const data: Record<string, unknown> = {};
  if ('budget' in body) {
    if (body.budget === null || body.budget === '') data.budgetYearly = null;
    else {
      const n = Number(body.budget);
      if (!Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max) errors.budget = `Choose a budget from ${naira(BUDGET.min)} to ${naira(BUDGET.max)}.`;
      else data.budgetYearly = Math.round(n / 1000) * 1000;
    }
  }
  if ('covers' in body) {
    const chosen = Array.isArray(body.covers) ? Array.from(new Set((body.covers as unknown[]).map(String))) : [];
    if (chosen.some((k) => !COVERS.some((c) => c.key === k))) errors.covers = 'Choose from the list.';
    else data.budgetCovers = JSON.stringify(chosen);
  }
  if ('whoPays' in body) {
    if (body.whoPays === null || body.whoPays === '') data.whoPays = null;
    else if (!WHO.includes(String(body.whoPays))) errors.whoPays = 'Choose who pays from the list.';
    else data.whoPays = String(body.whoPays);
  }
  if ('nelfund' in body) data.wantsNelfund = body.nelfund === true;
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted answers.', { fields: errors });
  if (Object.keys(data).length) await db.studentSettings.upsert({ where: { userId: me.id }, update: data, create: { userId: me.id, ...(data as any) } });
  const fresh = await getFinanceService(me);
  return { ...fresh, message: 'Saved' };
}

export async function followScholarshipService(me: AnyUser, id: unknown, on: unknown) {
  await ensureScholarships();
  if (typeof id !== 'string' || id.length > 64) return fail(404, 'Scholarship not found.');
  const s = await db.scholarship.findUnique({ where: { id } });
  if (!s || !s.active) return fail(404, 'Scholarship not found.');
  if (on === true) {
    await db.scholarshipFollow.upsert({ where: { scholarshipId_userId: { scholarshipId: id, userId: me.id } }, update: {}, create: { scholarshipId: id, userId: me.id } });
    return ok({ following: true }, s.closesAt ? 'Reminder on. We will email you 7 days and 1 day before it closes.' : 'Reminder on. We will email you once the closing date is confirmed, then again before it closes.');
  }
  await db.scholarshipFollow.deleteMany({ where: { scholarshipId: id, userId: me.id } });
  return ok({ following: false }, 'Reminder off');
}

/* ---------- Team: manage the list ---------- */
function parseScholarship(body: Record<string, unknown>, partial: boolean) {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const need = (key: string, max: number, label: string) => {
    if (!(key in body)) {
      if (!partial) errors[key] = `Enter ${label}.`;
      return;
    }
    const v = text(body[key], max);
    if (!v) errors[key] = `Enter ${label}.`;
    else out[key] = v;
  };
  need('name', 120, 'the scholarship name');
  need('funder', 120, 'who funds it');
  need('amountText', 120, 'what it pays');
  need('windowText', 120, 'when it usually opens');
  need('forText', 80, 'who it is for');
  if ('link' in body) {
    const v = text(body.link, 300);
    if (v && !/^https:\/\/[^\s]+$/.test(v)) errors.link = 'Use the full official address, starting with https://';
    else out.link = v || null;
  }
  if ('closesAt' in body) {
    if (!body.closesAt) out.closesAt = null;
    else {
      const d = new Date(String(body.closesAt));
      if (Number.isNaN(d.getTime())) errors.closesAt = 'Enter a real date.';
      else out.closesAt = d;
    }
  }
  if ('level' in body) {
    if (!LEVELS.includes(String(body.level))) errors.level = 'Choose a level from the list.';
    else out.level = String(body.level);
  }
  const pickList = (key: string, allowed: readonly string[]) => {
    if (!(key in body)) return;
    const v = Array.isArray(body[key]) ? Array.from(new Set((body[key] as unknown[]).map(String))) : [];
    if (v.some((x) => !allowed.includes(x))) errors[key] = 'Choose from the list.';
    else out[key] = v.length ? JSON.stringify(v) : null;
  };
  pickList('states', NIGERIAN_STATES);
  pickList('arms', ARMS);
  if ('gender' in body) {
    const g = String(body.gender || '');
    if (g && g !== 'FEMALE' && g !== 'MALE') errors.gender = 'Choose from the list.';
    else out.gender = g || null;
  }
  if ('schoolName' in body) out.schoolName = text(body.schoolName, 120) || null;
  if ('active' in body) out.active = body.active === true;
  return { errors, out };
}
const adminRow = (s: any, followers: number) => ({
  id: s.id, name: s.name, funder: s.funder, amountText: s.amountText, windowText: s.windowText, closesAt: s.closesAt, link: s.link, forText: s.forText,
  level: s.level, states: list(s.states), arms: list(s.arms), gender: s.gender, schoolName: s.schoolName, active: s.active, checkedAt: s.checkedAt, followers,
});

export async function adminListScholarshipsService() {
  await ensureScholarships();
  const rows = await db.scholarship.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { follows: true } } } });
  return ok({ scholarships: rows.map((s) => adminRow(s, s._count.follows)), options: { states: NIGERIAN_STATES, arms: ARMS, levels: LEVELS } });
}

export async function adminSaveScholarshipService(id: string | null, body: Record<string, unknown>) {
  await ensureScholarships();
  const { errors, out } = parseScholarship(body, !!id);
  if (Object.keys(errors).length) return fail(400, 'Check the highlighted answers.', { fields: errors });
  if (id) {
    const existing = await db.scholarship.findUnique({ where: { id } });
    if (!existing) return fail(404, 'Scholarship not found.');
    // A new closing date means students who follow it should be reminded again.
    const dateChanged = 'closesAt' in out && String(out.closesAt || '') !== String(existing.closesAt || '');
    const row = await db.scholarship.update({ where: { id }, data: { ...(out as any), checkedAt: new Date() } });
    if (dateChanged) await db.scholarshipFollow.updateMany({ where: { scholarshipId: id }, data: { sentWeek: null, sentDay: null } });
    return ok(adminRow(row, await db.scholarshipFollow.count({ where: { scholarshipId: id } })), 'Scholarship saved');
  }
  const base = String(out.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'scholarship';
  let slug = base;
  for (let i = 2; await db.scholarship.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  const row = await db.scholarship.create({ data: { ...(out as any), slug, checkedAt: new Date() } });
  return ok(adminRow(row, 0), 'Scholarship added', 201);
}

/* ---------- Reminder emails: 7 days and 1 day before a confirmed closing date ---------- */
export async function runScholarshipReminders(now = new Date()) {
  await ensureSettingsTables();
  const soon = await db.scholarship.findMany({ where: { active: true, closesAt: { gt: now, lte: new Date(now.getTime() + 7 * DAY) } } });
  let sent = 0;
  for (const s of soon) {
    const left = (s.closesAt as Date).getTime() - now.getTime();
    const stage: 'day' | 'week' = left <= DAY ? 'day' : 'week';
    const follows = await db.scholarshipFollow.findMany({ where: { scholarshipId: s.id, ...(stage === 'day' ? { sentDay: null } : { sentWeek: null, sentDay: null }) }, take: 200 });
    if (!follows.length) continue;
    const users = await db.user.findMany({ where: { id: { in: follows.map((f) => f.userId) } }, select: { id: true, email: true, firstname: true } });
    for (const u of users) {
      const result = await sendMail({
        recipients: [u.email],
        subject: stage === 'day' ? `Closes tomorrow: ${s.name}` : `Closes in a week: ${s.name}`,
        templateName: 'communityNotice',
        templateInfo: {
          label: 'Scholarship reminder',
          name: u.firstname || 'there',
          headline: stage === 'day' ? `${s.name} closes tomorrow` : `${s.name} closes in a week`,
          lines: ["Here's the reminder you asked for. Apply only on the official page. A real scholarship never asks you to pay to apply."],
          details: [
            { label: 'Closes', value: shortDate(s.closesAt as Date) },
            { label: 'What it pays', value: s.amountText },
            { label: 'Who it is for', value: s.forText },
          ],
          ctaLabel: s.link ? 'Open the official page' : 'See my scholarships',
          ctaUrl: s.link || `${siteUrl()}/dashboard/settings/financing`,
          secondaryLabel: s.link ? 'See my scholarships' : '',
          secondaryUrl: s.link ? `${siteUrl()}/dashboard/settings/financing` : '',
          footer: 'You are getting this email because you switched on a reminder for this scholarship on AlignTraits. You can switch it off on the Financing page.',
        },
      });
      if (result?.ok === false) continue;
      await db.scholarshipFollow.update({ where: { scholarshipId_userId: { scholarshipId: s.id, userId: u.id } }, data: stage === 'day' ? { sentDay: now } : { sentWeek: now } });
      sent++;
    }
  }
  return sent;
}
