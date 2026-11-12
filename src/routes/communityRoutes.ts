import express from 'express';
import { NextFunction, Request, Response } from 'express';
import { adminContCrtorLoginRequired, adminLoginRequired, loginRequired } from '../middlewares/auth';
import { db } from '../config/db';
import { handle, me } from './handle';
import {
  adminCloseReportedChatService,
  adminReportedChatsService,
  blockThreadService,
  inviteClassmateService,
  listThreadsService,
  reportThreadService,
  respondInviteService,
  searchClassmatesService,
  sendDirectMessageService,
  threadMessagesService,
} from '../services/directChatService';

/* Content managers look after exam dates and admission deadlines, so they can
   manage those two kinds of event. Everything else in Community admin is for admins. */
const CONTENT_KINDS = ['EXAM', 'DEADLINE'];
const contentEventsOnly = async (req: Request, res: Response, next: NextFunction) => {
  if ((req.user as any)?.role !== 'CONTENT_MANAGER') return next();
  try {
    if (req.body?.kind !== undefined && !CONTENT_KINDS.includes(req.body.kind)) {
      return res.status(403).json({ ok: false, status: 403, message: 'Content managers can add exam dates and deadlines only.' });
    }
    if (req.params.id) {
      const event = await db.communityEvent.findUnique({ where: { id: req.params.id }, select: { kind: true } });
      if (event && !CONTENT_KINDS.includes(event.kind)) {
        return res.status(403).json({ ok: false, status: 403, message: 'Content managers can change exam dates and deadlines only.' });
      }
    } else if (req.method === 'POST' && req.body?.kind === undefined) {
      return res.status(403).json({ ok: false, status: 403, message: 'Content managers can add exam dates and deadlines only.' });
    }
    next();
  } catch (error) {
    next(error);
  }
};
import * as c from '../controllers/communityController';

const router = express.Router();

/* Admins (registered first so "/admin/..." never matches a student route) */
router.get('/admin/events', adminContCrtorLoginRequired, c.adminEvents);
router.post('/admin/events', adminContCrtorLoginRequired, contentEventsOnly, c.adminCreateEvent);
router.patch('/admin/events/:id', adminContCrtorLoginRequired, contentEventsOnly, c.adminUpdateEvent);
router.post('/admin/events/:id/cancel', adminContCrtorLoginRequired, contentEventsOnly, c.adminCancelEvent);
router.delete('/admin/events/:id', adminContCrtorLoginRequired, contentEventsOnly, c.adminDeleteEvent);
router.get('/admin/channels', adminLoginRequired, c.adminChannels);
router.patch('/admin/channels/:id', adminLoginRequired, c.adminUpdateChannel);
router.get('/admin/channels/:id/messages', adminLoginRequired, c.adminChannelMessages);
router.post('/admin/channels/:id/messages', adminLoginRequired, c.adminPostMessage);
router.post('/admin/messages/:id/pin', adminLoginRequired, c.adminPinMessage);
router.post('/admin/messages/:id/keep', adminLoginRequired, c.adminKeepMessage);
router.delete('/admin/messages/:id', adminLoginRequired, c.adminDeleteMessage);
router.get('/admin/reports', adminLoginRequired, c.adminReports);
router.post('/admin/users/:userId/mute', adminLoginRequired, c.adminMuteUser);
router.get('/admin/inbox', adminLoginRequired, c.adminInbox);
router.get('/admin/inbox/:id', adminLoginRequired, c.adminInboxThread);
router.post('/admin/inbox/:id', adminLoginRequired, c.adminInboxReply);
router.get('/admin/direct-reports', adminLoginRequired, handle(() => adminReportedChatsService()));
router.post('/admin/direct-reports/:id/close', adminLoginRequired, handle((req) => adminCloseReportedChatService(req.params.id)));

/* Students (any signed-in account) */
router.get('/summary', loginRequired, c.summary);
router.get('/channels', loginRequired, c.channels);
router.post('/rules/accept', loginRequired, c.acceptRules);
router.post('/channels/:slug/join', loginRequired, c.joinChannel);
router.post('/channels/:slug/leave', loginRequired, c.leaveChannel);
router.get('/channels/:slug/messages', loginRequired, c.channelMessages);
router.post('/channels/:slug/messages', loginRequired, c.postChannelMessage);
router.delete('/messages/:id', loginRequired, c.deleteMessage);
router.post('/messages/:id/reactions', loginRequired, c.toggleReaction);
router.post('/messages/:id/report', loginRequired, c.reportMessage);
router.get('/team/messages', loginRequired, c.teamMessages);
router.post('/team/messages', loginRequired, c.postTeamMessage);
router.get('/events', loginRequired, c.events);
router.get('/events/:id', loginRequired, c.event);
router.post('/events/:id/reminder', loginRequired, c.setReminder);
router.delete('/events/:id/reminder', loginRequired, c.removeReminder);

/* Private chats between classmates of the same school */
router.get('/direct', loginRequired, handle((req) => listThreadsService(me(req))));
router.get('/direct/search', loginRequired, handle((req) => searchClassmatesService(me(req), req.query.q)));
router.post('/direct/invite', loginRequired, handle((req) => inviteClassmateService(me(req), req.body?.userId)));
router.post('/direct/:id/respond', loginRequired, handle((req) => respondInviteService(me(req), req.params.id, req.body?.accept)));
router.get('/direct/:id/messages', loginRequired, handle((req) => threadMessagesService(me(req), req.params.id, { after: req.query.after })));
router.post('/direct/:id/messages', loginRequired, handle((req) => sendDirectMessageService(me(req), req.params.id, req.body?.body)));
router.post('/direct/:id/block', loginRequired, handle((req) => blockThreadService(me(req), req.params.id)));
router.post('/direct/:id/report', loginRequired, handle((req) => reportThreadService(me(req), req.params.id, req.body?.reason)));

export default router;
