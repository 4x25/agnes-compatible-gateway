/** @jsxImportSource hono/jsx/dom */
import { render } from 'hono/jsx/dom'
import { Counter } from './counter.js'

render(<Counter />, document.getElementById('app')!)
