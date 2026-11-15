/*
  Profile and settings for students: the hub summary, Profile and Academic records.

  Everything shown comes from what the student has saved. UTME scores and O'Level
  grades stay in AcademicRecord, in the same slots the eligibility check reads, so
  changing them here changes the student's matches.
*/
import { db } from '../config/db';
import { ensureSettingsTables } from './settingsTables';
import { fail, ok } from './communityRules';
import { NIGERIAN_STATES, normaliseNigerianPhone } from './formsService';

type AnyUser = { id: string; role: string; firstname: string; lastname: string; email: string };

export const CLASSES = ['SS1', 'SS2', 'SS3', 'Finished secondary school'];
export const ARMS = ['Science', 'Arts', 'Commercial', 'Technical'];
export const RELATIONS = ['Mother', 'Father', 'Guardian', 'Sister', 'Brother', 'Aunt', 'Uncle', 'Grandparent', 'Other'];
export const OLEVEL_BODIES = ['WAEC', 'NECO', 'GCE', 'NABTEB'];
export const DIRECT_ENTRY_TYPES = ['A-Level', 'IJMB', 'JUPEB', 'ND', 'NCE'];
export const GRADES = ['A1', 'B2', 'B3', 'C4', 'C5', 'C6', 'D7', 'E8', 'F9'];
const CREDIT = new Set(['A1', 'B2', 'B3', 'C4', 'C5', 'C6']);
// Names match the ones courses use for their requirements, so do not rename them.
export const UTME_SUBJECTS = [
  'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Agricultural Science', 'Economics', 'Government', 'Literature in English',
  'Geography', 'Commerce', 'Accounting', 'Christian Religious Studies', 'Islamic Religious Studies', 'History', 'Fine Art', 'Music',
  'French', 'Yoruba', 'Igbo', 'Hausa', 'Home Economics', 'Computer Studies', 'Physical and Health Education',
];
export const OLEVEL_SUBJECTS = [
  'English', 'Mathematics', 'Civic Education', 'Physics', 'Chemistry', 'Biology', 'Geography', 'Economics', 'Accounting',
  'Christian Religious Studies', 'Islamic Religious Studies', 'Marketing', 'Government', 'History', 'Agricultural Science',
  'Computer Studies', 'Information and communication Technology', 'Fine Art', 'Visual Arts', 'Literature in English',
  'Business Studies', 'Physical and Health Education', 'Commerce', 'Home Economics', 'Further Mathematics', 'Technical Drawing',
  'French', 'Yoruba', 'Igbo', 'Hausa', 'Food and Nutrition', 'Music', 'Statistics', 'Insurance', 'Trade Subject',
  'Entrepreneurial Subject',
];
const ENGLISH = 'English';
const MATHS = 'Mathematics';
const SLOTS = 10;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const nameOk = (v: string) => /^[\p{L}][\p{L}\p{M}' .-]*$/u.test(v);
const parseList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(',').map((x) => x.trim()).filter(Boolean);
  }
};
const isUtme = (t: string) => t === 'JAMB' || t === 'UTME';
const isOlevel = (t: string) => OLEVEL_BODIES.includes(t);

type Rec = Record<string, unknown> | null;
function slotOf(record: Rec, match: (type: string) => boolean): number | null {
  if (!record) return null;
  for (let i = 1; i <= SLOTS; i++) if (match(String(record[`ExamType${i}`] || '').toUpperCase())) return i;
  return null;
}
function freeSlot(record: Rec, taken: number[]): number | null {
  for (let i = 1; i <= SLOTS; i++) if (!taken.includes(i) && (!record || !String(record[`ExamType${i}`] || '').trim())) return i;
  return null;
}
function readSlot(record: Rec, i: number | null) {
  if (!record || !i) return { type: '', subjects: [] as string[], grades: [] as string[] };
  return { type: String(record[`ExamType${i}`] || ''), subjects: parseList(record[`ExamType${i}Subjects`]), grades: parseList(record[`ExamType${i}SubGrades`]) };
}

function academicsOf(record: Rec, s: any) {
  const u = readSlot(record, slotOf(record, isUtme));
  const utmeSubjects = u.subjects.map((subject, i) => ({ subject, score: Number.isFinite(parseFloat(u.grades[i])) ? Math.round(parseFloat(u.grades[i])) : null }));
  const scored = utmeSubjects.filter((x) => x.score !== null);
  const total = scored.length ? scored.reduce((a, b) => a + (b.score as number), 0) : null;

  const o = readSlot(record, slotOf(record, isOlevel));
  const grades = o.subjects.map((subject, i) => ({ subject, grade: GRADES.includes(o.grades[i]) ? o.grades[i] : '' })).filter((g) => g.grade);
  const credits = grades.filter((g) => CREDIT.has(g.grade));
  const awaiting = s?.olevelStatus === 'AWAITING';
  return {
    utme: { year: s?.utmeYear ?? null, subjects: utmeSubjects, total, complete: scored.length === 4 },
    olevel: {
      status: awaiting ? 'AWAITING' : 'OUT',
      examBody: o.type ? o.type.toUpperCase() : '',
      year: s?.olevelYear ?? null,
      sittings: s?.olevelSittings === 2 ? 2 : 1,
      grades,
      credits: credits.length,
      hasEnglish: credits.some((g) => g.subject === ENGLISH),
      hasMaths: credits.some((g) => g.subject === MATHS),
    },
    directEntry: { on: !!s?.directEntry, type: s?.directEntryType || '' },
  };
}

/** What is filled in, as a percentage, and the single most useful thing to add next. */
function strengthOf(user: any, s: any, a: ReturnType<typeof academicsOf>, hasSchool: boolean) {
  const olevelDone = a.olevel.status === 'OUT' && a.olevel.grades.length >= 5;
  const parts: { done: boolean; weight: number; label: string; to: string }[] = [
    { done: !!(user.firstname && user.lastname), weight: 10, label: 'your name', to: 'profile' },
    { done: a.utme.complete, weight: 20, label: 'your UTME scores', to: 'records' },
    { done: olevelDone, weight: 15, label: "your O'Level grades", to: 'records' },
    { done: !!s?.classLevel, weight: 10, label: 'your class', to: 'profile' },
    { done: !!s?.stateOfOrigin, weight: 10, label: 'your state of origin', to: 'profile' },
    { done: !!user.region, weight: 5, label: 'the state you live in', to: 'profile' },
    { done: !!user.dob, weight: 10, label: 'your date of birth', to: 'profile' },
    { done: !!user.contactNumber, weight: 10, label: 'your phone number', to: 'profile' },
    { done: !!(s?.guardianName && s?.guardianPhone), weight: 5, label: 'a parent or guardian', to: 'profile' },
    { done: hasSchool, weight: 5, label: 'your secondary school', to: 'profile' },
  ];
  const percent = parts.filter((p) => p.done).reduce((n, p) => n + p.weight, 0);
  const missing = parts.filter((p) => !p.done).sort((x, y) => y.weight - x.weight);
  const next = missing[0] || null;
  return {
    percent,
    next: next ? { label: next.label, to: next.to, reaches: missing.length === 1 ? 100 : percent + next.weight } : null,
  };
}

const dateOnly = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function load(userId: string) {
  await ensureSettingsTables();
  const [user, settings, record, link] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    db.studentSettings.findUnique({ where: { userId } }),
    db.academicRecord.findFirst({ where: { userId } }),
    db.partnerSchoolStudent.findUnique({ where: { userId }, include: { school: { select: { id: true, name: true, active: true } } } }),
  ]);
  const school = link && !link.removedAt && link.school.active ? { id: link.school.id, name: link.school.name } : null;
  return { user, settings, record: record as Rec, school, schoolClass: link?.classLevel ?? null };
}

export async function getStudentSettingsService(me: AnyUser) {
  const { user, settings, record, school, schoolClass } = await load(me.id);
  if (!user) return fail(404, 'Account not found.');
  const s: any = settings ? { ...settings, classLevel: settings.classLevel || schoolClass } : { classLevel: schoolClass };
  const academics = academicsOf(record, s);
  const results = academics.utme.complete || academics.olevel.grades.length ? 'Results added' : academics.olevel.status === 'AWAITING' ? 'Awaiting results' : 'No results yet';
  return ok({
    profile: {
      firstname: user.firstname,
      middleName: s.middleName || '',
      lastname: user.lastname,
      dob: dateOnly(user.dob),
      classLevel: s.classLevel || '',
      classArm: s.classArm || '',
      stateOfOrigin: s.stateOfOrigin || '',
      stateLive: user.region || '',
      phone: user.contactNumber || '',
      email: user.email,
      emailVerified: !!user.emailVerified,
      whatsappSame: s.whatsappSame ?? true,
      guardianName: s.guardianName || '',
      guardianRelation: s.guardianRelation || '',
      guardianPhone: s.guardianPhone || '',
    },
    school,
    academics,
    strength: strengthOf(user, s, academics, !!school),
    summary: { classLevel: s.classLevel || '', state: user.region || '', results },
    options: {
      states: NIGERIAN_STATES, classes: CLASSES, arms: ARMS, relations: RELATIONS, examBodies: OLEVEL_BODIES, grades: GRADES,
      utmeSubjects: UTME_SUBJECTS, olevelSubjects: OLEVEL_SUBJECTS, directEntryTypes: DIRECT_ENTRY_TYPES,
    },
  });
}

export async function saveStudentProfileService(me: AnyUser, body: Record<string, unknown>) {
  await ensureSettingsTables();
  const errors: Record<string, string> = {};
  const firstname = text(body.firstname, 60);
  const lastname = text(body.lastname, 60);
  const middleName = text(body.middleName, 60);
  if (!firstname || !nameOk(firstname)) errors.firstname = 'Enter your first name.';
  if (!lastname || !nameOk(lastname)) errors.lastname = 'Enter your last name.';
  if (middleName && !nameOk(middleName)) errors.middleName = 'Use letters only.';

  let dob: Date | null = null;
  const rawDob = text(body.dob, 10);
  if (rawDob) {
    const d = new Date(`${rawDob}T00:00:00.000Z`);
    const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDob) || Number.isNaN(d.getTime()) || age < 8 || age > 80) errors.dob = 'Enter a real date of birth.';
    else dob = d;
  }
  const pick = (v: unknown, list: readonly string[], key: string, label: string) => {
    const t = text(v, 60);
    if (t && !list.includes(t)) errors[key] = `Choose ${label} from the list.`;
    return t || null;
  };
  const classLevel = pick(body.classLevel, CLASSES, 'classLevel', 'a class');
  const classArm = pick(body.classArm, ARMS, 'classArm', 'a class arm');
  const stateOfOrigin = pick(body.stateOfOrigin, NIGERIAN_STATES, 'stateOfOrigin', 'a state');
  const stateLive = pick(body.stateLive, NIGERIAN_STATES, 'stateLive', 'a state');
  const guardianRelation = pick(body.guardianRelation, RELATIONS, 'guardianRelation', 'a relationship');

  const phoneOf = (v: unknown, key: string) => {
    const t = text(v, 30);
    if (!t) return null;
    const n = normaliseNigerianPhone(t);
    if (!n) errors[key] = 'Enter a Nigerian phone number, for example 0803 555 0142.';
    return n;
  };
  const phone = phoneOf(body.phone, 'phone');
  const guardianPhone = phoneOf(body.guardianPhone, 'guardianPhone');
  const guardianName = text(body.guardianName, 80);
  if (guardianName && !nameOk(guardianName)) errors.guardianName = 'Use letters only.';
  if (guardianPhone && phone && guardianPhone === phone) errors.guardianPhone = 'Use a different number from your own.';

  if (Object.keys(errors).length) return fail(400, 'Check the highlighted answers.', { fields: errors });

  await db.user.update({ where: { id: me.id }, data: { firstname, lastname, dob, region: stateLive, contactNumber: phone } });
  const data = { middleName: middleName || null, classLevel, classArm, stateOfOrigin, whatsappSame: body.whatsappSame !== false, guardianName: guardianName || null, guardianRelation, guardianPhone };
  await db.studentSettings.upsert({ where: { userId: me.id }, update: data, create: { userId: me.id, ...data } });
  const fresh = await getStudentSettingsService(me);
  return { ...fresh, message: 'Profile saved' };
}

export async function saveStudentAcademicsService(me: AnyUser, body: Record<string, unknown>) {
  await ensureSettingsTables();
  const errors: Record<string, string> = {};
  const thisYear = new Date().getFullYear();
  const yearOf = (v: unknown, key: string) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1990 || n > thisYear + 1) {
      errors[key] = 'Choose a year.';
      return null;
    }
    return n;
  };

  // UTME: Use of English plus three other subjects, each scored out of 100.
  const utmeIn = Array.isArray((body.utme as any)?.subjects) ? ((body.utme as any).subjects as any[]) : [];
  const utme: { subject: string; score: number }[] = [];
  const seenU = new Set<string>();
  for (const row of utmeIn.slice(0, 4)) {
    const subject = text(row?.subject, 60);
    const raw = row?.score;
    if (!subject || raw === '' || raw === null || raw === undefined) continue;
    const score = Number(raw);
    if (subject !== ENGLISH && !UTME_SUBJECTS.includes(subject)) errors.utme = 'Choose your UTME subjects from the list.';
    else if (seenU.has(subject)) errors.utme = 'Each UTME subject can only appear once.';
    else if (!Number.isInteger(score) || score < 0 || score > 100) errors.utme = 'Each UTME score is a whole number from 0 to 100.';
    else {
      seenU.add(subject);
      utme.push({ subject, score });
    }
  }
  if (utme.length && !errors.utme) {
    if (!seenU.has(ENGLISH)) errors.utme = 'Use of English is compulsory. Add your score for it.';
    else if (utme.length !== 4) errors.utme = 'Enter all four UTME subject scores, or leave them all empty.';
  }
  const utmeYear = yearOf((body.utme as any)?.year, 'utmeYear');

  // O'Level
  const o = (body.olevel as any) || {};
  const awaiting = o.status === 'AWAITING';
  const examBody = text(o.examBody, 12).toUpperCase();
  const gradesIn = Array.isArray(o.grades) ? (o.grades as any[]) : [];
  const grades: { subject: string; grade: string }[] = [];
  const seenO = new Set<string>();
  if (!awaiting) {
    for (const row of gradesIn.slice(0, 12)) {
      const subject = text(row?.subject, 60);
      const grade = text(row?.grade, 2).toUpperCase();
      if (!subject || !grade) continue;
      if (!OLEVEL_SUBJECTS.includes(subject)) errors.olevel = "Choose your O'Level subjects from the list.";
      else if (!GRADES.includes(grade)) errors.olevel = 'Choose each grade from the list, A1 to F9.';
      else if (seenO.has(subject)) errors.olevel = "Each O'Level subject can only appear once.";
      else {
        seenO.add(subject);
        grades.push({ subject, grade });
      }
    }
    if (grades.length && !OLEVEL_BODIES.includes(examBody)) errors.examBody = 'Choose the exam body.';
    if (grades.length > 9) errors.olevel = 'Add at most nine subjects.';
  }
  const olevelYear = yearOf(o.year, 'olevelYear');
  const olevelSittings = Number(o.sittings) === 2 ? 2 : 1;

  const de = (body.directEntry as any) || {};
  const directEntry = de.on === true;
  const directEntryType = directEntry ? text(de.type, 20) : '';
  if (directEntry && directEntryType && !DIRECT_ENTRY_TYPES.includes(directEntryType)) errors.directEntry = 'Choose your qualification from the list.';

  if (Object.keys(errors).length) return fail(400, 'Check the highlighted answers.', { fields: errors });

  // Write scores and grades into the slots the eligibility check reads. Other exams are left alone.
  const record = (await db.academicRecord.findFirst({ where: { userId: me.id } })) as Rec;
  const patch: Record<string, string | null> = {};
  const put = (i: number, type: string | null, subjects: string[], values: string[]) => {
    patch[`ExamCountry${i}`] = type ? 'Nigeria' : null;
    patch[`ExamType${i}`] = type;
    patch[`ExamType${i}Subjects`] = type ? JSON.stringify(subjects) : null;
    patch[`ExamType${i}SubGrades`] = type ? JSON.stringify(values) : null;
  };
  let uSlot = slotOf(record, isUtme);
  let oSlot = slotOf(record, isOlevel);
  if (utme.length) {
    if (!uSlot) uSlot = freeSlot(record, oSlot ? [oSlot] : []);
    if (!uSlot) return fail(409, 'Your record is full. Message us on WhatsApp and we will help.');
    put(uSlot, 'JAMB', utme.map((x) => x.subject), utme.map((x) => String(x.score)));
  } else if (uSlot) put(uSlot, null, [], []);
  if (grades.length) {
    if (!oSlot) oSlot = freeSlot(record, uSlot ? [uSlot] : []);
    if (!oSlot) return fail(409, 'Your record is full. Message us on WhatsApp and we will help.');
    put(oSlot, examBody, grades.map((x) => x.subject), grades.map((x) => x.grade));
  } else if (oSlot) put(oSlot, null, [], []);

  if (record) await db.academicRecord.update({ where: { id: String(record.id) }, data: patch as any });
  else if (Object.values(patch).some(Boolean)) await db.academicRecord.create({ data: { userId: me.id, ...(patch as any) } });

  const data = { utmeYear, olevelStatus: awaiting ? 'AWAITING' : 'OUT', olevelYear, olevelSittings, directEntry, directEntryType: directEntryType || null };
  await db.studentSettings.upsert({ where: { userId: me.id }, update: data, create: { userId: me.id, ...data } });
  const fresh = await getStudentSettingsService(me);
  return { ...fresh, message: 'Academic records saved. Your matches use these from now on.' };
}
