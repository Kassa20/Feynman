import type { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
        return res.status(401).json({ message: 'Missing Authorization header' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }

    req.user = data.user;
    next();
}
