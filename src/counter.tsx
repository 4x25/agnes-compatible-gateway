/** @jsxImportSource hono/jsx/dom */
import { useState } from 'hono/jsx'

export function Counter() {
  const [count, setCount] = useState(0)

  return (
    <button
      type="button"
      onClick={() => setCount((previous) => previous + 1)}
      style={{ padding: '16px 32px', fontSize: '24px', cursor: 'pointer' }}
    >
      点击次数：<span aria-live="polite">{count}</span>
    </button>
  )
}
