export function Page() {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>点击计数器</title>
      </head>
      <body style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', margin: 0, fontFamily: 'system-ui' }}>
        <div id="app" />
        <script type="module" src="/assets/client.js" />
      </body>
    </html>
  )
}
