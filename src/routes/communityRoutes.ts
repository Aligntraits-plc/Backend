import express from 'express';
import { adminLoginRequired, loginRequired } from '../middlewares/auth';
import * as c from '../controllers/communityController';

const router = express.Router();

/* Admins (registered first so "/admin/..." never matches a student route) */
router.get('/admin/events', adminLoginRequired, c.adminEvents);
router.post('/admin/events', adminLoginRequired, c.adminCreateEvent);
router.patch('/admin/events/:id', adminLoginRequired, c.adminUpdateEvent);
router.post('/admin/events/:id/cancel', adminLoginRequired, c.adminCancelEvent);
router.delete('/admin/events/:id', adminLoginRequired, c.adminDeleteEvent);
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

export default router;
