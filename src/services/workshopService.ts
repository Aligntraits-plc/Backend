/*
  Workshop courses.

  Until the first real course is uploaded, students see PREVIEW courses: an outline of
  what is planned, clearly marked as a preview. They carry no lecturer name, no
  enrolment figure and no dates, because none of those exist yet. "Notify me when
  this opens" is real: it is saved, and the count per course shows the team which
  course to produce first.
*/
import { db } from '../config/db';
import { ensureSettingsTables } from './settingsTables';
import { fail, ok } from './communityRules';

type AnyUser = { id: string; role: string };

export const WORKSHOP_CATEGORIES = ['UTME Prep', 'Career Skills', 'Study Skills', 'Application Help'];

type Week = { title: string; topics: string[]; note: string };
type Preview = {
  slug: string; category: string; title: string; summary: string; cover: string;
  weeks: number; sessions: number; level: 'Beginner' | 'Intermediate';
  outcomes: string[]; syllabus: Week[];
};

const PREVIEWS: Preview[] = [
  {
    slug: 'post-utme-mathematics-intensive', category: 'UTME Prep', title: 'Post-UTME Mathematics Intensive', cover: 'maths',
    summary: 'Six weeks of timed practice on the maths topics that come up most in Post-UTME screening.',
    weeks: 6, sessions: 12, level: 'Intermediate',
    outcomes: ['Solve Post-UTME maths questions in under 60 seconds each', 'Spot the topics that appear most in screening papers', 'Sit two full timed mocks with marked feedback', 'Leave with a personal revision plan for the final weeks'],
    syllabus: [
      { title: 'Number bases, indices and logarithms', topics: ['Converting between bases', 'Laws of indices', 'Logarithms without a calculator'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Algebra and quadratic equations', topics: ['Factorising quickly', 'The quadratic formula', 'Word problems'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Sequences, series and variation', topics: ['Arithmetic and geometric progressions', 'Direct, inverse and joint variation'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Geometry and mensuration', topics: ['Circle theorems', 'Areas and volumes of solids', 'Bearings and distances'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Statistics and probability', topics: ['Mean, median and mode from tables', 'Probability of combined events'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Mock Post-UTME and review', topics: ['Full timed mock', 'Going through every question together'], note: '2 live sessions · 1 full mock' },
    ],
  },
  {
    slug: 'use-of-english-comprehension-and-lexis', category: 'UTME Prep', title: 'Use of English: Comprehension and Lexis', cover: 'english',
    summary: 'Read faster, answer comprehension with evidence, and stop losing marks on lexis and structure.',
    weeks: 4, sessions: 8, level: 'Beginner',
    outcomes: ['Finish a comprehension passage with time to spare', 'Answer from the passage, not from memory', 'Handle synonyms, antonyms and sentence completion with a method', 'Know the oral English sounds that are tested most'],
    syllabus: [
      { title: 'Reading for the answer', topics: ['Skimming and scanning', 'Finding the evidence line'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Lexis: words in context', topics: ['Synonyms and antonyms', 'Idioms and registers'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Structure', topics: ['Sentence completion', 'Concord and tenses', 'Common traps'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Oral English and timed practice', topics: ['Vowels, consonants and stress', 'A full timed paper'], note: '2 live sessions · 1 full paper' },
    ],
  },
  {
    slug: 'physics-past-questions-explained', category: 'UTME Prep', title: 'Physics Past Questions, Explained', cover: 'physics',
    summary: 'Past UTME physics questions worked step by step, so you learn the method and not just the answer.',
    weeks: 5, sessions: 10, level: 'Intermediate',
    outcomes: ['Recognise which formula a question is asking for', 'Work through calculations without a calculator', 'Avoid the unit and sign mistakes that cost marks', 'Build a formula sheet you understand'],
    syllabus: [
      { title: 'Motion and forces', topics: ['Equations of motion', "Newton's laws", 'Projectiles'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Work, energy and machines', topics: ['Work and power', 'Efficiency of machines'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Heat and waves', topics: ['Heat capacity and latent heat', 'Wave properties and sound'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Light and electricity', topics: ['Mirrors and lenses', "Ohm's law and circuits"], note: '2 live sessions · 1 practice quiz' },
      { title: 'Modern physics and timed paper', topics: ['Radioactivity and half-life', 'A full timed paper'], note: '2 live sessions · 1 full paper' },
    ],
  },
  {
    slug: 'choosing-a-course-with-your-results', category: 'Career Skills', title: 'Choosing a Course With Your Results', cover: 'choice',
    summary: 'How to pick a first, second and safety choice from your scores, your budget and what the course leads to.',
    weeks: 2, sessions: 4, level: 'Beginner',
    outcomes: ['Read a cut-off mark and a subject combination correctly', 'Choose a reach, a realistic match and a safety net', 'Compare the year one cost of each choice', 'Explain your choices to a parent in five minutes'],
    syllabus: [
      { title: 'What your results allow', topics: ['Cut-off marks and how they move', 'Subject combinations', 'O’Level requirements'], note: '2 live sessions' },
      { title: 'Building a shortlist you can afford', topics: ['Reach, realistic match and safety net', 'Fees, acceptance fees and other first-year costs', 'Talking it through at home'], note: '2 live sessions · 1 worksheet' },
    ],
  },
  {
    slug: 'a-study-plan-that-lasts', category: 'Study Skills', title: 'A Study Plan That Lasts', cover: 'study',
    summary: 'Build a weekly plan around school, chores and data, and keep to it until the exam.',
    weeks: 3, sessions: 6, level: 'Beginner',
    outcomes: ['Plan a realistic week, hour by hour', 'Use past questions to decide what to study next', 'Revise so that it stays in your memory', 'Recover a plan after a bad week'],
    syllabus: [
      { title: 'Your real week', topics: ['Finding your study hours', 'Setting weekly targets'], note: '2 live sessions · 1 worksheet' },
      { title: 'Studying that sticks', topics: ['Active recall', 'Spacing your revision', 'Using past questions'], note: '2 live sessions · 1 practice quiz' },
      { title: 'Exam month', topics: ['The last four weeks', 'Sleep, stress and the night before'], note: '2 live sessions' },
    ],
  },
  {
    slug: 'post-utme-screening-step-by-step', category: 'Application Help', title: 'Post-UTME Screening, Step by Step', cover: 'apply',
    summary: 'From JAMB result to admission letter: what to do, in what order, and what to keep ready.',
    weeks: 2, sessions: 4, level: 'Beginner',
    outcomes: ['Know each step between your UTME result and your admission letter', 'Prepare the documents schools ask for', 'Use the JAMB portal for change of course and admission status', 'Avoid paying anyone who promises to "help" your admission'],
    syllabus: [
      { title: 'After your UTME result', topics: ['Registering for screening', 'Uploading your O’Level result', 'Change of course or institution'], note: '2 live sessions · 1 checklist' },
      { title: 'From screening to acceptance', topics: ['Checking admission status on CAPS', 'Accepting an offer and paying the acceptance fee', 'Staying safe from admission scams'], note: '2 live sessions · 1 checklist' },
    ],
  },
];

const card = (p: Preview, notify: boolean) => ({
  slug: p.slug, category: p.category, title: p.title, summary: p.summary, cover: p.cover,
  weeks: p.weeks, sessions: p.sessions, level: p.level, preview: true, notify,
});

export async function listWorkshopsService(me: AnyUser) {
  await ensureSettingsTables();
  const mine = await db.workshopInterest.findMany({ where: { userId: me.id }, select: { courseSlug: true } });
  const set = new Set(mine.map((m) => m.courseSlug));
  return ok({ categories: WORKSHOP_CATEGORIES, courses: PREVIEWS.map((p) => card(p, set.has(p.slug))), previewOnly: true });
}

export async function getWorkshopService(me: AnyUser, slug: unknown) {
  await ensureSettingsTables();
  const p = PREVIEWS.find((x) => x.slug === slug);
  if (!p) return fail(404, 'We could not find that course.');
  const mine = await db.workshopInterest.findUnique({ where: { courseSlug_userId: { courseSlug: p.slug, userId: me.id } } });
  return ok({ ...card(p, !!mine), outcomes: p.outcomes, syllabus: p.syllabus.map((w, i) => ({ week: i + 1, ...w })) });
}

export async function notifyWorkshopService(me: AnyUser, slug: unknown, on: unknown) {
  await ensureSettingsTables();
  const p = PREVIEWS.find((x) => x.slug === slug);
  if (!p) return fail(404, 'We could not find that course.');
  if (on === true) {
    await db.workshopInterest.upsert({ where: { courseSlug_userId: { courseSlug: p.slug, userId: me.id } }, update: {}, create: { courseSlug: p.slug, userId: me.id } });
    return ok({ notify: true }, 'Done. We will email you when this course opens.');
  }
  await db.workshopInterest.deleteMany({ where: { courseSlug: p.slug, userId: me.id } });
  return ok({ notify: false }, 'You will not be notified about this course.');
}

/** For the team: how many students asked to be told about each course. */
export async function workshopInterestService() {
  await ensureSettingsTables();
  const rows = await db.workshopInterest.groupBy({ by: ['courseSlug'], _count: { _all: true } });
  const countOf = (slug: string) => rows.find((r) => r.courseSlug === slug)?._count._all || 0;
  return ok({ courses: PREVIEWS.map((p) => ({ slug: p.slug, title: p.title, category: p.category, interested: countOf(p.slug) })).sort((a, b) => b.interested - a.interested) });
}
