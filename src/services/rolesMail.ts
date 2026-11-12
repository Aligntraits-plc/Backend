// Emails for Roles v1. They all use the plain "communityNotice" template.
import { sendMail } from './mailServices';

export const siteUrl = () => (process.env.WEBSITE_URL || 'https://aligntraits.com').replace(/\/+$/, '');

type Notice = {
  to: string;
  subject: string;
  name: string;
  label?: string;
  headline: string;
  lines: string[];
  details?: { label: string; value: string }[];
  ctaUrl?: string;
  ctaLabel?: string;
  footer?: string;
};

/** Sends one notice. Returns false (and logs) when it could not be sent, never throws. */
export async function sendNotice(n: Notice): Promise<boolean> {
  try {
    const result = await sendMail({
      recipients: [n.to],
      subject: n.subject,
      templateName: 'communityNotice',
      templateInfo: {
        label: n.label || '',
        headline: n.headline,
        name: n.name,
        lines: n.lines,
        details: n.details || [],
        ctaUrl: n.ctaUrl || '',
        ctaLabel: n.ctaLabel || '',
        secondaryUrl: '',
        secondaryLabel: '',
        footer: n.footer || 'You are getting this email because someone used this address on aligntraits.com.',
      },
    });
    return !!result?.ok;
  } catch (error) {
    console.error('Could not send email:', n.subject, error);
    return false;
  }
}

/* A simple daily budget so our own invitation emails can never use up the day's
   sending allowance and block sign-up and password emails. Kept in memory: after
   a restart the count starts again, which only allows a few more. */
const DAY = 24 * 60 * 60 * 1000;
let sentToday: number[] = [];
export const INVITE_EMAILS_PER_DAY = Math.max(0, Number(process.env.INVITE_EMAILS_PER_DAY ?? 40) || 0);

export function inviteBudgetLeft() {
  sentToday = sentToday.filter((t) => Date.now() - t < DAY);
  return Math.max(0, INVITE_EMAILS_PER_DAY - sentToday.length);
}
export function noteInviteEmail() {
  sentToday.push(Date.now());
}
