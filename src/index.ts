import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './page.js'

const app = new Hono()

app.use('/assets/*', serveStatic({ root: './dist' }))

app.get('/', (c) => {
  return c.html(Page())
})

serve({
  fetch: app.fetch,
  port: 3000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
