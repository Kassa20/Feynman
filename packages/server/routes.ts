import express from 'express'
import type { Request, Response } from 'express';
import { chatController } from './controllers/chat.controller';


const router = express.Router()

router.get('/', (req: Request, res: Response) => {
    res.send('Server online!')
})

router.post('/api/chat', chatController.sendMessage);


export default router;