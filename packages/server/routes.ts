import express from 'express'
import type { Request, Response } from 'express';
import { chatController } from './controllers/chat.controller';
import { conversationController } from './controllers/conversation.controller';
import { labGenerationController } from './controllers/labGeneration.controller';
import { requireAuth } from './middleware/auth.middleware';
import { notesController } from './controllers/notes.controller';



const router = express.Router()

router.get('/', (req: Request, res: Response) => {
    res.send('Server online!')
})

router.post('/api/chat', requireAuth, chatController.sendMessage);
router.get('/api/conversations', requireAuth, conversationController.list);
router.get('/api/conversations/:id/messages', requireAuth, conversationController.getMessages);
router.get('/api/notes', requireAuth, notesController.listNotes);
router.get('/api/labs/:id/starter-code', requireAuth, labGenerationController.downloadStarterCode)
router.post('/api/labs/generate', requireAuth, labGenerationController.generate);


export default router;