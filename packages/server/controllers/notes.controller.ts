import type { Request, Response } from 'express';
import { notesService } from '../services/notes.service';

export const notesController = {
    async listNotes(req: Request, res: Response) {
        try {
            const notes = await notesService.listNotes(req.user!.id)
            res.json({ notes })
        }
        catch (error) {
            console.error('[notes] error:', error)
            res.status(500).json({ message: 'Something went wrong' })
        }
    }
}