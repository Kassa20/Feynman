import express from 'express'
import type { Request, Response } from 'express';
import { chatController } from './controllers/chat.controller';
import { conversationController } from './controllers/conversation.controller';
import { requireAuth } from './middleware/auth.middleware';


const router = express.Router()

router.get('/', (req: Request, res: Response) => {
    res.send('Server online!')
})

router.post('/api/chat', requireAuth, chatController.sendMessage);
router.get('/api/conversations', requireAuth, conversationController.list);
router.get('/api/conversations/:id/messages', requireAuth, conversationController.getMessages);


export default router;