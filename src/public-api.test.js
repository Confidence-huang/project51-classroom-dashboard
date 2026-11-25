/* Check deployment selection and local API overrides without using the network. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { publicApiBase } from './public-api.js'

test('published lookups use the configured API even when a link provides another URL', () => {
  const page = 'https://confidence-huang.github.io/smart-classroom-web/?api=https://other.example'
  assert.equal(publicApiBase(page), 'https://api.careerpathdesk.com')
  assert.equal(publicApiBase(page, 'https://trusted.example/'), 'https://trusted.example')
})

test('local overrides use a parsed loopback address and cannot resemble one', () => {
  const page = 'http://127.0.0.1:5173/?api='
  assert.equal(publicApiBase(page + 'http://127.0.0.1:8899'), 'http://127.0.0.1:8899')
  assert.equal(publicApiBase(page + 'http://127.0.0.1.example:8899'), '')
  assert.equal(publicApiBase(page + 'http://user@127.0.0.1:8899'), '')
})
