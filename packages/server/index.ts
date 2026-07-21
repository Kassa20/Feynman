import type { Request, Response } from 'express';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';


const express = require('express')
const app = express()

app.use(express.json())

app.get('/', (req: Request, res: Response) => {
    res.send("server online!")
})

app.post('/api/chat', async (req: Request, res: Response) => {
    const { text } = await generateText({
        model: openai("gpt-4o"),
        prompt: req.body.message,
    })
    res.json({ text })
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`)
})

