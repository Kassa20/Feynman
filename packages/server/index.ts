import './lib/instrumentation';
import router from './routes';


const express = require('express')
const app = express()

app.use(express.json())
app.use(router)


const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`)
})

