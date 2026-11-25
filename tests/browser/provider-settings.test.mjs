import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAccountServer } from '../../server/index.mjs'
import { historyFileSize, historyPicture, historySessionCount, historySessionId, makeHistoryZip } from './history-fixtures.mjs'

const findBrowser = async () => {
  const edge = 'Microsoft/Edge/Application/msedge.exe'
  const chrome = 'Google/Chrome/Application/chrome.exe'
  const candidates = [
    process.env.AIHUB_BROWSER,
    ...['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'].flatMap((key) =>
      process.env[key] ? [join(process.env[key], edge), join(process.env[key], chrome)] : []
    ),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const path of candidates) {
    if (await access(path).then(() => true, () => false)) return path
  }
  throw new Error('Install Chrome, Edge, or Chromium, or set AIHUB_BROWSER to its executable.')
}

const completion = (text) => new Response(
  'data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) +
    '\n\ndata: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } }
)

const deepSeekCompletion = (body) => {
  const content = body.messages.filter((message) => message.role === 'user').at(-1).content
  const prompt = typeof content === 'string' ? content : content.find((block) => block.type === 'text').text
  const stream = [
    { type: 'message_start', message: { id: 'fixture-ds', model: body.model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'DeepSeek reply: ' + prompt } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ].map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
}

const imageIds = (body) => body.messages.flatMap(({ content }) =>
  Array.isArray(content) ? content.filter(({ type }) => type === 'image').map(({ source }) => source.file_id) : []
)

test('provider editing, image uploads and history survive account sync and reload', { timeout: 125_000 }, async (t) => {
  const browserPath = await findBrowser()
  const webDir = resolve('dist')
  await access(join(webDir, 'index.html'))
  const { version } = JSON.parse(await readFile(join(webDir, 'version.json'), 'utf8'))
  const directory = await mkdtemp(join(tmpdir(), 'aihub-provider-browser-'))
  const browserProfile = join(directory, 'browser')
  const actualFetch = globalThis.fetch
  const openai = 'https://api.openai.com/v1'
  const deepseek = 'https://api.deepseek.com'
  const deepseekKey = 'fixture-deepseek-key'
  const localKey = 'fixture-local-only-key'
  const rotatedKey = 'fixture-rotated-key'
  const calls = []
  let upstream
  let outputLimit
  let reasoningEffort
  let searchRequest
  let speechRequest
  let uploadAttempts = 0
  const imageUploads = []
  const imageReplies = []
  let lastChatContent
  let transcribed = false
  let invalidOpenAIKey = false
  let browser
  let socket
  let app
  const grants = new Map()
  const server = createServer((req, res) => {
    const request = new URL(req.url, origin)
    res.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    if (request.pathname !== '/login/oauth/authorize') {
      app.emit('request', req, res)
      return
    }
    const state = request.searchParams.get('state')
    grants.set(state, request.searchParams.get('code_challenge'))
    const callback = new URL(request.searchParams.get('redirect_uri'))
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', state)
    res.writeHead(303, { Location: callback.href }).end()
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    globalThis.fetch = actualFetch
    socket?.close()
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = once(browser, 'exit')
      browser.kill()
      await Promise.race([closed, sleep(2000, null, { ref: false })])
    }
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    app?.emit('close')
    if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('aihub-provider-browser-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  app = createAccountServer({
    origin, issuer: origin, clientId: 'fixture', clientSecret: 'fixture',
    users: new Set(['fixture-alice']), key: randomBytes(32),
    endpoints: new Map([[openai, 'openai'], [deepseek, 'deepseek']]), webDir, dataDir: join(directory, 'data'),
  })
  globalThis.fetch = async (url, init) => {
    switch (String(url)) {
      case origin + '/login/oauth/access_token': {
        const code = init.body.get('code')
        const challenge = createHash('sha256').update(init.body.get('code_verifier')).digest('base64url')
        assert.equal(challenge, grants.get(code))
        grants.delete(code)
        return Response.json({ access_token: 'fixture-token' })
      }
      case origin + '/login/oauth/userinfo':
        return Response.json({ sub: '42', preferred_username: 'fixture-alice' })
      case openai + '/models':
        calls.push({ path: '/models', auth: init.headers.get('authorization') })
        return Response.json({ data: [
          { id: 'fixture-model', name: 'Provider name' },
          { id: 'listed-fixture-model', name: 'Listed by provider', context_window: 65536, max_output_tokens: 16384 },
          { id: 'unselected-fixture-model', name: 'Another model' },
        ] })
      case openai + '/chat/completions': {
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        const { model, messages, max_completion_tokens, reasoning_effort } = JSON.parse(Buffer.concat(chunks).toString())
        upstream = { model, auth: init.headers.get('authorization') }
        outputLimit = max_completion_tokens
        reasoningEffort = reasoning_effort
        calls.push(upstream)
        lastChatContent = messages.at(-1).content
        if (invalidOpenAIKey) {
          return Response.json({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401 })
        }
        const question = Array.isArray(lastChatContent) ? lastChatContent.at(-1).text : lastChatContent
        const widgets = question === 'render widgets'
          ? '\n\n$$x^2 + y^2$$\n\n```mermaid\ngraph TD\nA[Start] --> B[Done]\n```'
          : ''
        return completion('Account reply: ' + question + widgets)
      }
      case openai + '/responses': {
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        const auth = init.headers.get('authorization')
        const body = JSON.parse(Buffer.concat(chunks).toString())
        searchRequest = { auth, body }
        const events = [
          { type: 'response.output_text.delta', item_id: 'fixture', content_index: 0, delta: 'Search reply: ' + body.input.at(-1).content },
          { type: 'response.output_text.annotation.added', item_id: 'fixture', content_index: 0,
            annotation: { type: 'url_citation', url: 'https://example.com/search-source', title: 'Search fixture' } },
          { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 12 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
        return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      case deepseek + '/models':
        return Response.json({ data: [{ id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 }] })
      case deepseek + '/anthropic/v1/files': {
        assert.equal(init.headers.get('x-api-key'), deepseekKey)
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'Content-Type': init.headers.get('content-type') },
        }).formData()
        const file = form.get('file')
        if (file.type === 'image/png') {
          const bytes = Buffer.from(await file.arrayBuffer())
          const width = bytes.readUInt32BE(16)
          const height = bytes.readUInt32BE(20)
          assert.ok(Math.max(width, height) <= 4096, 'DeepSeek received an oversized image')
          assert.equal(form.has('purpose'), false)
          const id = 'file_fixture_' + (imageUploads.length + 1)
          imageUploads.push({ id, name: file.name, width, height, sha256: createHash('sha256').update(bytes).digest('hex') })
          return Response.json({ id })
        }
        uploadAttempts++
        return Response.json({ error: { message: 'Unsupported file format' } }, { status: 400 })
      }
      case deepseek + '/anthropic/v1/messages': {
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        const request = JSON.parse(Buffer.concat(chunks).toString())
        const ids = imageIds(request)
        assert.ok(!ids.includes('file_legacy_wide') && !ids.includes('file_legacy_tall'))
        assert.equal(init.headers.get('anthropic-beta'), 'files-api-2025-04-14')
        imageReplies.push(ids)
        return deepSeekCompletion(request)
      }
      case deepseek + '/v1/tools/asr': {
        assert.equal(init.headers.get('authorization'), 'Bearer ' + deepseekKey)
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        const recording = Buffer.concat(chunks)
        const offset = recording.indexOf('RIFF')
        assert.ok(offset >= 0)
        assert.equal(recording.toString('ascii', offset + 8, offset + 12), 'WAVE')
        assert.equal(recording.readUInt32LE(offset + 24), 16000)
        transcribed = true
        return Response.json({ text: '账号录音转写测试' })
      }
      case deepseek + '/v1/tools/tts': {
        const chunks = []
        for await (const chunk of init.body) chunks.push(chunk)
        speechRequest = { auth: init.headers.get('authorization'), body: JSON.parse(Buffer.concat(chunks).toString()) }
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new Uint8Array([0, 128, 255, 127]))
            await sleep(150)
            controller.close()
          },
        }), { headers: { 'Content-Type': 'audio/pcm' } })
      }
      default:
        assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+\//)
        return actualFetch(url, init)
    }
  }
  browser = spawn(browserPath, [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    `--user-data-dir=${browserProfile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let devToolsPort
  for (let attempt = 0; attempt < 80 && !devToolsPort; attempt++) {
    devToolsPort = await readFile(join(browserProfile, 'DevToolsActivePort'), 'utf8')
      .then((body) => body.split('\n')[0], () => '')
    if (!devToolsPort) await sleep(100)
  }
  assert.ok(devToolsPort, 'Browser did not start')
  const tabs = await actualFetch(`http://127.0.0.1:${devToolsPort}/json/list`).then((res) => res.json())
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl)
  await once(socket, 'open')
  let serial = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const { id, result, error } = JSON.parse(data)
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (error) request.reject(new Error(error.message))
    else request.resolve(result)
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, awaitPromise = false) => {
    const value = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description)
    return value.result.value
  }
  const until = async (expression, waitMs = 4000) => {
    const deadline = Date.now() + waitMs
    do {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(40)
    } while (Date.now() < deadline)
    const visible = await evaluate('document.body.innerText.slice(-700)')
    const probes = await evaluate(`Array.from(document.querySelectorAll('[data-connection]'), node => [node.dataset.connection, node.ariaLabel])`)
    assert.fail(`Browser condition timed out: ${expression}\nProvider status: ${JSON.stringify(probes)}\nPage text: ${visible}`)
  }
  const providerStorageKey = () => evaluate(`(async () => {
    const { workspace } = await fetch('/api/account/session').then((response) => response.json())
    return 'ai-hub:account:' + workspace + ':ai-hub:providers'
  })()`, true)
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`)
  const enterText = async (selector, text) => {
    await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select() })()`)
    await cdp('Input.insertText', { text })
  }
  const viewport = (width, height, mobile) =>
    cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  const chooser = 'button[aria-label="选择模型"]'
  const workspaceStorage = '[role="combobox"][aria-label="会话与设置保存位置"]'
  const thinking = 'button[aria-label="深度思考"]'
  const search = 'button[aria-label="智能搜索"]'
  const edit = async (name) => {
    await click(`button[aria-label="编辑 ${name}"]`)
    await until('document.querySelector(\'input[type="url"]\')')
  }
  const providerRows = `document.querySelectorAll('[role="dialog"] button[aria-label^="编辑 "]').length`
  const closeSettings = () => click('[role="dialog"] button[aria-label="关闭"]')
  const saveSettings = async () => {
    await clickText('[role="dialog"] button', '保存')
    await until(`${providerRows} === 2 && !document.querySelector('[role="dialog"] input[type="password"]')`)
  }
  const openProviders = async (expectedCount = 2) => {
    await until(`(() => {
      const button = document.querySelector('button[aria-label="设置"][aria-haspopup="menu"]')
      if (!button) return false
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth
    })()`)
    await click('button[aria-label="设置"][aria-haspopup="menu"]')
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some(node => node.textContent.trim() === '模型供应商')`)
    await clickText('[role="menuitem"]', '模型供应商')
    await until(`${providerRows} === ${expectedCount}`)
  }
  const send = async (text, prefix) => {
    await enterText('textarea', text)
    await until("document.querySelector('button[aria-label=\"发送\"]')?.getAttribute('aria-disabled') !== 'true'")
    await click('button[aria-label="发送"]')
    await until(`document.body.textContent.includes(${JSON.stringify(prefix + text)}) && !document.querySelector('button[aria-label="停止生成"]')`)
  }
  const attachImages = (images) => evaluate(`(async () => {
    const transfer = new DataTransfer()
    const digests = {}
    for (const [name, width, height] of ${JSON.stringify(images)}) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      context.fillStyle = '#597bf1'
      context.fillRect(0, 0, width, height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      canvas.width = canvas.height = 0
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      digests[name] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      transfer.items.add(new File([blob], name, { type: 'image/png' }))
    }
    const input = document.querySelector('input[type="file"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return digests
  })()`, true)
  const readReply = (text, label) => evaluate(`(() => {
    const answer = [...document.querySelectorAll('.ds-assistant-message-main-content')].find(node => node.textContent.includes(${JSON.stringify(text)}))
    answer.closest('[data-message-id]').querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}).click()
  })()`)
  const profiles = [
    {
      id: 'browser-fixture', name: 'Fixture OpenAI', protocol: 'openai', baseUrl: openai,
      apiKey: localKey, models: ['fixture-model'], scope: 'browser-fixture-scope',
    },
    {
      id: 'deepseek-default', name: 'DeepSeek', protocol: 'deepseek', baseUrl: 'https://api.deepseek.com',
      apiKey: deepseekKey, models: ['deepseek-flash'], scope: 'legacy-deepseek',
    },
  ]
  const signIn = `[...document.querySelectorAll('button')].some(node => node.textContent === '使用 Gitea 登录')`
  const installModelsFixture = `(() => {
      const actual = window.fetch
      window.fetch = (url, init) => {
        if (url === ${JSON.stringify(openai + '/models')}) return Promise.resolve(Response.json({ data: [{ id: 'fixture-model' }] }))
        if (url === 'https://api.deepseek.com/models') return Promise.resolve(window.fixtureDeepSeekAvailable
          ? Response.json({ data: [{ id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 }] })
          : Response.json({ error: { message: 'Unavailable fixture' } }, { status: 401 }))
        return actual(url, init)
      }
    })()`
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('chat-demo:locale', 'zh-CN')" })
  await viewport(1100, 760, false)
  await cdp('Page.navigate', { url: origin })
  await until(signIn)
  await evaluate(`localStorage.setItem('ai-hub:providers', ${JSON.stringify(JSON.stringify(profiles))})`)
  await clickText('button', '使用 Gitea 登录')
  await until(`document.querySelector(${JSON.stringify(chooser)})?.closest('[class^="wrapper-"]') && !document.querySelector(${JSON.stringify(chooser)}).disabled`)
  await evaluate(installModelsFixture)
  await evaluate(`(() => {
    const actual = fetch
    const reply = ${completion.toString()}
    window.fetch = (url, init) => {
      if (url !== ${JSON.stringify(openai + '/chat/completions')}) return actual(url, init)
      if (init.headers.Authorization !== ${JSON.stringify('Bearer ' + localKey)}) throw Error('Unexpected local key')
      return Promise.resolve(reply('Browser reply: ' + JSON.parse(init.body).messages.at(-1).content))
    }
  })()`)
  await send('before-edit', 'Browser reply: ')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(thinking)})).visibility`), 'visible')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(thinking)}).ariaDisabled`), 'true')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(search)}).ariaDisabled`), 'true')

  await openProviders()
  await until(`document.querySelector('section[aria-label="Fixture OpenAI"] [data-connection="connected"][aria-label="API 已连通"]') &&
    document.querySelector('section[aria-label="DeepSeek"] [data-connection="unreachable"][aria-label="API 未连通"]') &&
    document.querySelector('section[aria-label="Fixture OpenAI"]').textContent.includes('1 个模型 · 仅浏览器')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-connection="connected"]')).backgroundColor`), 'rgb(34, 197, 94)')
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('[data-connection="unreachable"]')).backgroundColor`), 'rgb(34, 197, 94)')
  await evaluate(`(() => {
    const style = document.createElement('style')
    style.textContent = '[role="tabpanel"]::-webkit-scrollbar { width: 16px }'
    document.head.append(style)
  })()`)
  const measurePanel = `(() => {
    const panel = document.querySelector('[role="tabpanel"]')
    const row = panel.querySelector('section[aria-label="Fixture OpenAI"]')
    return {
      width: panel.clientWidth,
      gutter: panel.offsetWidth - panel.clientWidth,
      edges: [row.offsetLeft, row.offsetLeft + row.offsetWidth],
      scrolls: panel.scrollHeight > panel.clientHeight,
    }
  })()`
  const collapsed = await evaluate(measurePanel)
  assert.equal(collapsed.gutter, 16)
  assert.equal(collapsed.scrolls, false)
  await edit('Fixture OpenAI')
  await until(`document.querySelector('section[aria-label="Fixture OpenAI"] form input[type="url"]') &&
    document.querySelector('button[aria-label="收起 Fixture OpenAI"]').getAttribute('aria-expanded') === 'true' &&
    document.querySelector('button[aria-label="编辑 DeepSeek"]')`)
  assert.deepEqual(await evaluate(measurePanel), { ...collapsed, scrolls: true })
  const fieldStyles = `Array.from(document.querySelectorAll('form input, form [role="combobox"], [aria-label="供应商模板"]'), (field) => {
    const style = getComputedStyle(field)
    return [field.offsetHeight, style.borderRadius, style.borderTopWidth,
      style.borderTopStyle, style.borderTopColor, style.backgroundColor, style.paddingInlineStart]
  })`
  const assertSharedFields = async (height) => {
    const fields = await evaluate(fieldStyles)
    assert.equal(fields.length, 9)
    assert.deepEqual(fields[0].slice(0, 4), [height, '12px', '1px', 'solid'])
    for (const field of fields) assert.deepEqual(field, fields[0])
  }
  await assertSharedFields(36)
  const focusBorder = await evaluate(`(() => {
    const sample = document.createElement('span')
    sample.style.color = 'var(--dsw-alias-brand-primary)'
    document.body.append(sample)
    const color = getComputedStyle(sample).color
    sample.remove()
    return color
  })()`)
  for (const selector of ['form input', '[aria-label="接口协议"]']) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await until(`getComputedStyle(document.activeElement).borderTopColor === ${JSON.stringify(focusBorder)}`)
  }
  await evaluate('document.activeElement.blur()')
  await until(`new Set((${fieldStyles}).map(field => field[4])).size === 1`)
  await viewport(320, 680, true)
  await until(`document.querySelector('form input').offsetHeight === 44`)
  await assertSharedFields(44)
  assert.equal(await evaluate(`(() => {
    const panel = document.querySelector('[role="tabpanel"]')
    return panel.scrollWidth === panel.clientWidth
  })()`), true)
  await viewport(1100, 760, false)
  await until(`document.querySelector('form input').offsetHeight === 36`)
  await enterText('[role="dialog"] form input[required]:not([type])', 'Draft retained')
  await click('button[aria-label="收起 Fixture OpenAI"]')
  await until(`document.querySelector('section[aria-label="Fixture OpenAI"] form').closest('[hidden]') &&
    document.querySelector('button[aria-label="编辑 Fixture OpenAI"]').getAttribute('aria-expanded') === 'false'`)
  assert.deepEqual(await evaluate(measurePanel), collapsed)
  await edit('Fixture OpenAI')
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] form input[required]:not([type])').value`), 'Draft retained')
  await enterText('[role="dialog"] form input[required]:not([type])', 'Edited OpenAI')
  await saveSettings()
  await closeSettings()
  await until('!document.querySelector(\'[role="dialog"]\')')
  await send('after-local-edit', 'Browser reply: ')

  await openProviders()
  await edit('Edited OpenAI')
  await click('[role="combobox"][aria-label="保存位置"]')
  await clickText('[role="option"]', '同步到 AI Hub 账号')
  await until(`[...document.querySelectorAll('[role="dialog"] button')].some(node => node.textContent === '获取可用模型' && node.disabled && getComputedStyle(node).opacity === '1' && node.getAttribute('aria-describedby'))`)
  await saveSettings()
  const firstProviderStorage = await providerStorageKey()
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(firstProviderStorage)}).includes(${JSON.stringify(localKey)})`), false)
  assert.equal(await evaluate(`localStorage.getItem('ai-hub:providers')`), null)
  await closeSettings()
  await until('!document.querySelector(\'[role="dialog"]\')')
  await send('after-move', 'Account reply: ')
  assert.deepEqual(upstream, { model: 'fixture-model', auth: 'Bearer ' + localKey })

  await openProviders()
  await clickText('[role="tab"]', '账户管理')
  await until(`document.querySelector('[role="tabpanel"] img[alt="Gitea"]')?.naturalWidth > 0 && document.querySelector('[role="tabpanel"]').textContent.includes('用户名fixture-alice')`)
  await clickText('[role="tab"]', '模型供应商')
  await edit('Edited OpenAI')
  await until(`document.querySelector('section[aria-label="Edited OpenAI"]').textContent.includes('1 个模型 · 账号同步')`)
  const idInput = '[data-catalog-row] input[aria-label="模型 ID"]'
  const nameInput = '[data-catalog-row] input[aria-label="显示名"]'
  const ids = `Array.from(document.querySelectorAll(${JSON.stringify(idInput)}), node => node.value)`
  await enterText(nameInput, 'Custom model label')
  await clickText('[role="dialog"] button', '＋添加模型')
  await enterText('[data-catalog-row]:last-child input[aria-label="模型 ID"]', 'manual-model')
  const openDiscovery = async () => {
    await clickText('[role="dialog"] button', '获取可用模型')
    await until(`document.querySelectorAll('[role="dialog"] input[type="checkbox"]').length === 3`)
    assert.equal(await evaluate(`(() => {
      const search = document.querySelector('input[aria-label="搜索模型名称或 ID"]')
      const field = document.querySelector('form input')
      const searchStyle = getComputedStyle(search)
      const fieldStyle = getComputedStyle(field)
      return search.offsetHeight === field.offsetHeight &&
        ['borderRadius', 'borderTopWidth', 'backgroundColor'].every(key => searchStyle[key] === fieldStyle[key])
    })()`), true)
  }
  const discoveryButtons = '[role="dialog"]:has(input[aria-label="搜索模型名称或 ID"]) button'
  await openDiscovery()
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] input[type="checkbox"]').checked`), true)
  await clickText('[role="dialog"] button', '全选')
  assert.equal(await evaluate(`document.querySelectorAll('[role="dialog"] input[type="checkbox"]:checked').length`), 3)
  await clickText(discoveryButtons, '取消')
  await until(`document.querySelectorAll('[role="dialog"]').length === 1`)
  assert.deepEqual(await evaluate(ids), ['fixture-model', 'manual-model'])
  await openDiscovery()
  await enterText('input[aria-label="搜索模型名称或 ID"]', 'Listed by provider')
  await until(`document.querySelectorAll('[role="dialog"] input[type="checkbox"]').length === 1`)
  await clickText('[role="dialog"] button', '全选搜索结果')
  await clickText(discoveryButtons, '更新列表')
  await until(`document.querySelectorAll('[role="dialog"]').length === 1`)
  assert.deepEqual(await evaluate(ids), ['fixture-model', 'manual-model', 'listed-fixture-model'])
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(nameInput)}), node => node.value)`), ['Custom model label', '', 'Listed by provider'])
  assert.deepEqual(calls.at(-1), { path: '/models', auth: 'Bearer ' + localKey })
  const listedGrip = 'button[aria-label^="排序模型 listed-fixture-model，"]'
  const manualId = '[data-catalog-row] input[aria-label="模型 ID"]'
  await evaluate(`document.querySelector(${JSON.stringify(listedGrip)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await until(`(() => {
    const handle = document.querySelector(${JSON.stringify(listedGrip)})
    const rect = handle.getBoundingClientRect()
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === handle
  })()`)
  const drag = await evaluate(`(() => {
    const handle = document.querySelector(${JSON.stringify(listedGrip)})
    const source = handle.getBoundingClientRect()
    const target = [...document.querySelectorAll(${JSON.stringify(manualId)})]
      .find(input => input.value === 'manual-model').closest('[data-catalog-row]').getBoundingClientRect()
    return { x: source.left + source.width / 2, from: source.top + source.height / 2, to: target.top + 8 }
  })()`)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x, y: drag.from, button: 'left', buttons: 1, clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x, y: drag.to, buttons: 1 })
  await until(`document.querySelector('[data-drop-edge="before"]')`)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x, y: drag.to, button: 'left', clickCount: 1 })
  assert.deepEqual(await evaluate(ids), ['fixture-model', 'listed-fixture-model', 'manual-model'])
  for (const [key, order] of [
    ['ArrowDown', ['fixture-model', 'manual-model', 'listed-fixture-model']],
    ['ArrowUp', ['fixture-model', 'listed-fixture-model', 'manual-model']],
  ]) {
    await evaluate(`document.querySelector(${JSON.stringify(listedGrip)}).focus()`)
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key })
    assert.deepEqual(await evaluate(ids), order)
  }
  const context = 'input[inputmode="numeric"]:first-of-type'
  const max = 'label:nth-child(2) input[inputmode="numeric"]'
  await click('button[aria-label="展开 listed-fixture-model 的参数"]')
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(context)}).placeholder`), /65[,]?536/)
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(max)}).placeholder`), /16[,]?384/)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(max)}).value`), '')
  await click('button[aria-label="收起 listed-fixture-model 的参数"]')
  await click('button[aria-label="移除模型 manual-model"]')
  await click('button[aria-label="移除模型 listed-fixture-model"]')
  await click('button[aria-label="展开 fixture-model 的参数"]')
  await enterText(context, '65536')
  await enterText(max, '65537')
  await click('button[aria-label="收起 fixture-model 的参数"]')
  await clickText('[role="dialog"] button', '保存')
  await until(`document.querySelector('[role="tabpanel"] [role="status"]').textContent.includes('输出上限不能超过')`)
  await click('button[aria-label="展开 fixture-model 的参数"]')
  await enterText(max, '8192')
  await enterText('[role="dialog"] input[type="password"]', rotatedKey)
  await enterText(idInput, 'gpt-6.1-sol')
  await saveSettings()
  await closeSettings()
  await until('!document.querySelector(\'[role="dialog"]\')')
  await send('after-rotation', 'Account reply: ')
  assert.deepEqual(upstream, { model: 'gpt-6.1-sol', auth: 'Bearer ' + rotatedKey })
  assert.equal(outputLimit, 8192)
  assert.equal(reasoningEffort, 'low')

  await cdp('Page.reload', { ignoreCache: true })
  await until(`document.querySelector('[data-session-id]')`)
  await evaluate(installModelsFixture)
  await click('[data-session-id]')
  await until(`document.querySelector(${JSON.stringify(chooser)})?.textContent.includes('Custom model label') &&
    document.querySelector(${JSON.stringify(chooser)}).title === 'gpt-6.1-sol'`)
  await send('after-reload', 'Account reply: ')
  await until(`document.querySelector('[data-session-id] [aria-current="true"]')`)
  const selectChats = 'button[aria-label="多选"]'
  const selectPoint = await evaluate(`(() => {
    const bounds = document.querySelector(${JSON.stringify(selectChats)}).getBoundingClientRect()
    return { x: bounds.left + bounds.width / 2, y: bounds.bottom - 1 }
  })()`)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...selectPoint })
  await until(`(() => {
    const button = document.querySelector(${JSON.stringify(selectChats)})
    const tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(node => node.textContent === '多选')
    const row = document.querySelector('[data-session-id] [aria-current="true"]')?.closest('[data-session-id]')
    return tooltip && row && document.elementFromPoint(${selectPoint.x}, ${selectPoint.y})?.closest('button') === button &&
      tooltip.getBoundingClientRect().bottom < row.getBoundingClientRect().top &&
      button.getBoundingClientRect().bottom < row.getBoundingClientRect().top
  })()`)
  await click(selectChats)
  await until(`document.querySelector('[data-session-id] [role="checkbox"]') &&
    ![...document.querySelectorAll('[role="tooltip"]')].some(node => node.textContent === '多选')`)
  await click('button[aria-label="退出多选"]')
  await until(`document.querySelector('[data-session-id] [aria-current="true"]')`)
  assert.equal(upstream.auth, 'Bearer ' + rotatedKey)
  assert.equal(outputLimit, 8192)
  await until(`document.querySelector(${JSON.stringify(thinking)}).ariaDisabled === 'false' &&
    document.querySelector(${JSON.stringify(search)}).ariaDisabled === 'false'`)
  await click(thinking)
  await send('openai-high-effort', 'Account reply: ')
  assert.equal(reasoningEffort, 'high')
  await click(search)
  await send('openai-search', 'Search reply: ')
  assert.equal(searchRequest.auth, 'Bearer ' + rotatedKey)
  assert.equal(searchRequest.body.model, 'gpt-6.1-sol')
  assert.deepEqual(searchRequest.body.reasoning, { effort: 'high' })
  assert.deepEqual(searchRequest.body.tools, [{ type: 'web_search' }])
  assert.equal(searchRequest.body.max_output_tokens, 8192)
  assert.equal(searchRequest.body.store, false)
  await until(`document.querySelector('.ds-markdown-cite[role="link"]')?.textContent === '1'`)
  assert.equal(await evaluate(`(() => {
    const original = window.open
    let url
    window.open = (target) => { url = target }
    try { document.querySelector('.ds-markdown-cite[role="link"]').click() }
    finally { window.open = original }
    return url
  })()`), 'https://example.com/search-source')
  await evaluate(`(() => {
    window.spoken = []
    window.cancelled = 0
    window.speechSynthesis.getVoices = () => []
    window.speechSynthesis.speak = (utterance) => {
      window.spoken.push([utterance.text, utterance.lang])
      window.currentUtterance = utterance
      utterance.onstart()
    }
    window.speechSynthesis.cancel = () => { window.cancelled += 1 }
  })()`)
  await readReply('Search reply: openai-search', '朗读')
  assert.deepEqual(await evaluate('window.spoken'), [['Search reply: openai-search', 'en-US']])
  await readReply('Search reply: openai-search', '停止朗读')
  assert.equal(await evaluate('window.cancelled'), 1)
  await readReply('Search reply: openai-search', '朗读')
  await evaluate('window.currentUtterance.onend()')
  await until(`!document.querySelector('button[aria-label="停止朗读"]')`)
  await click(search)
  await click(thinking)

  // The model menu is a list with a separate, fully rounded settings action.
  const chooserSelector = JSON.stringify(chooser)
  const popup = '[role="dialog"][data-menu-side]'
  const manage = popup + ' > :last-child > button'
  await click(chooser)
  await until(`document.querySelector(${JSON.stringify(popup)})?.querySelector('input') === null &&
    document.activeElement.matches('[role="option"][aria-selected="true"]')`)
  const [x, y] = await evaluate(`(() => {
    const { left, top, width, height } = document.querySelector(${JSON.stringify(manage)}).getBoundingClientRect()
    return [left + width / 2, top + height / 2]
  })()`)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await until(`(() => {
    const button = document.querySelector(${JSON.stringify(manage)})
    const style = getComputedStyle(button)
    return button.matches(':hover') && style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius,
       style.borderBottomRightRadius].every(radius => parseFloat(radius) >= 8)
  })()`)
  assert.ok(await evaluate(`document.querySelector(${JSON.stringify(manage)}).getBoundingClientRect().height >= 36`))

  const readMarks = `(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const ctx = canvas.getContext('2d')
    return Object.fromEntries(Array.from(document.querySelectorAll('[role="option"] img'), (img) => {
      ctx.clearRect(0, 0, 16, 16)
      ctx.filter = getComputedStyle(img).filter
      ctx.drawImage(img, 0, 0, 16, 16)
      const pixels = ctx.getImageData(0, 0, 16, 16).data
      const ink = []
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] >= 220) ink.push(Array.from(pixels.slice(i, i + 3)))
      }
      return [img.dataset.provider, { pixels: ink, transparent: pixels[3] === 0, width: img.clientWidth }]
    }))
  })()`
  await until(`document.querySelectorAll('[role="option"] img').length === 2 &&
    Array.from(document.querySelectorAll('[role="option"] img')).every(img => img.naturalWidth > 0)`)
  const sampleTheme = async (theme) => {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await until(`document.body.classList.contains(${JSON.stringify(theme)})`)
    return evaluate(readMarks)
  }
  const light = await sampleTheme('light')
  const dark = await sampleTheme('dark')
  for (const marks of [light, dark]) {
    assert.ok(Object.values(marks).every(mark => mark.transparent && mark.width === 16 && mark.pixels.length))
    assert.ok(marks.deepseek.pixels.some(([red, green, blue]) => blue > red + 80 && blue > green + 70))
  }
  assert.deepEqual(light.deepseek, dark.deepseek)
  assert.ok(light.openai.pixels.every(rgb => rgb.every(channel => channel === 0)))
  assert.ok(dark.openai.pixels.every(rgb => rgb.every(channel => channel === 255)))
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector(${JSON.stringify(popup)}) && document.activeElement.matches(${chooserSelector})`)

  await viewport(320, 680, true)
  await click(chooser)
  await until(`(() => {
    const menu = document.querySelector('[data-menu-side="top"] [role="listbox"]')?.parentElement
    if (!menu || menu.querySelectorAll('[role="option"] img').length !== 2) return false
    const box = menu.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth
  })()`)
  await clickText('[role="option"]', 'deepseek-flash')
  await until(`(() => {
    const trigger = document.querySelector(${JSON.stringify(chooser)})
    const row = trigger.closest('[class^="functionRow-"]')
    const tools = row.querySelector('[class^="toggles-"]').getBoundingClientRect()
    const box = trigger.getBoundingClientRect()
    const send = row.querySelector('button[aria-label="发送"]').getBoundingClientRect()
    return trigger.textContent === 'deepseek-flash' && trigger.querySelector('img') &&
      tools.right <= box.left && send.right <= row.getBoundingClientRect().right &&
      document.querySelectorAll(${JSON.stringify(chooser)}).length === 1
  })()`)

  // Observe the actual Anthropic-format request built from the composer switch.
  await evaluate(`(() => {
    const actual = fetch
    const reply = ${deepSeekCompletion.toString()}
    window.fixtureDeepSeekRequests = []
    window.fixtureDirectImageSize = null
    window.fetch = async (url, init) => {
      if (url === 'https://api.deepseek.com/anthropic/v1/files') {
        const image = await createImageBitmap(init.body.get('file'))
        window.fixtureDirectImageSize = [image.width, image.height]
        image.close()
        return Response.json({ id: 'file_direct_image' })
      }
      if (url !== 'https://api.deepseek.com/anthropic/v1/messages') return actual(url, init)
      const body = JSON.parse(init.body)
      window.fixtureDeepSeekRequests.push(body)
      return reply(body)
    }
  })()`)
  await until(`document.querySelector(${JSON.stringify(thinking)}).getAttribute('aria-pressed') === 'false'`)
  await send('thinking disabled', 'DeepSeek reply: ')
  await click(thinking)
  await send('thinking enabled', 'DeepSeek reply: ')
  const requests = await evaluate('window.fixtureDeepSeekRequests')
  assert.deepEqual(requests.map(request => request.thinking.type), ['disabled', 'enabled'])
  assert.ok(requests.every(request => !Object.hasOwn(request, 'output_config') &&
    !Object.hasOwn(request, 'reasoning_effort')))
  await attachImages([['direct-wide.png', 6000, 1500]])
  await send('browser direct image', 'DeepSeek reply: ')
  assert.deepEqual(await evaluate('window.fixtureDirectImageSize'), [4096, 1024])
  assert.deepEqual(imageIds(await evaluate('window.fixtureDeepSeekRequests.at(-1)')), ['file_direct_image'])

  await viewport(1100, 760, false)
  await evaluate('window.fixtureDeepSeekAvailable = true')
  await openProviders()
  await until(`document.querySelector('section[aria-label="DeepSeek"] [data-connection="connected"]')`)
  await edit('Edited OpenAI')
  await click('button[aria-label="展开 gpt-6.1-sol 的参数"]')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(context)}).value`), '65536')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(max)}).value`), '8192')
  await click('button[aria-label="移除模型 gpt-6.1-sol"]')
  await clickText('[role="dialog"] button', '保存')
  await until(`document.querySelector('[role="dialog"]').textContent.includes('请添加目录模型或填写默认模型 ID。')`)
  await enterText('input[placeholder="留空时使用目录第一项"]', 'fixture-default-outside-catalog')
  await saveSettings()
  await closeSettings()
  await until('!document.querySelector(\'[role="dialog"]\')')
  await click(chooser)
  await clickText('[role="option"]', '使用默认模型')
  await send('catalog-free', 'Account reply: ')
  assert.deepEqual(upstream, { model: 'fixture-default-outside-catalog', auth: 'Bearer ' + rotatedKey })
  assert.equal(outputLimit, undefined)

  await openProviders()
  await until(`document.querySelector('section[aria-label="DeepSeek"] [data-connection="connected"]')`)
  await edit('DeepSeek')
  await click('button[aria-label="展开 deepseek-flash 的参数"]')
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(context)}).placeholder`), /1[,]?048[,]?576/)
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(max)}).placeholder`), /393[,]?216/)
  await click('[role="combobox"][aria-label="保存位置"]')
  await clickText('[role="option"]', '同步到 AI Hub 账号')
  await saveSettings()
  await until(`document.querySelector('section[aria-label="DeepSeek"]').textContent.includes('账号同步')`)
  await closeSettings()
  await until(`!document.querySelector('[role="dialog"]')`)
  await evaluate(`(() => {
    window.pcmEvents = []
    window.originalAudioContext = window.AudioContext
    window.AudioContext = class extends EventTarget {
      currentTime = 0
      destination = {}
      async resume() { window.pcmEvents.push('resume') }
      async close() { window.pcmEvents.push('close') }
      createBuffer(channels, samples, rate) {
        return { duration: samples / rate, copyToChannel(data) { window.pcmEvents.push([...data]) } }
      }
      createBufferSource() {
        return { connect() {}, start() { setTimeout(() => this.onended(), 10) } }
      }
    }
  })()`)
  await readReply('DeepSeek reply: thinking enabled', '朗读')
  await until(`window.pcmEvents.includes('close') && !document.querySelector('button[aria-label="停止朗读"]')`)
  assert.deepEqual(await evaluate('window.pcmEvents'), ['resume', [-1, 32767 / 32768], 'close'])
  assert.deepEqual(speechRequest, {
    auth: 'Bearer ' + deepseekKey,
    body: { text: 'DeepSeek reply: thinking enabled', voice_id: 'stella', format: 'pcm', filter_markdown: true },
  })

  // Upload errors from an old connection must not block a supported file after switching models.
  await click(chooser)
  await clickText('[role="option"]', 'deepseek-flash')
  await evaluate('window.AudioContext = window.originalAudioContext')
  await click('button[aria-label="语音输入"]')
  await until(`document.body.textContent.includes('录音中 1s')`)
  await click('button[aria-label="结束录音并转写"]')
  await until(`document.querySelector('textarea').value === '账号录音转写测试'`)
  assert.equal(transcribed, true)
  await evaluate(`(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Audit fixture content'], 'provider-switch.txt', { type: 'text/plain' }))
    const input = document.querySelector('input[type="file"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`document.body.textContent.includes('provider-switch.txt') && document.querySelector('button[aria-label="发送"]').getAttribute('aria-disabled') === 'true'`)
  await until(`document.body.textContent.includes('上传失败')`)
  assert.equal(uploadAttempts, 1)
  await click(chooser)
  await clickText('[role="option"]', '使用默认模型')
  const textAttachmentLink = 'a[aria-label="provider-switch.txt"][download="provider-switch.txt"]'
  await until(`document.querySelector(${JSON.stringify(textAttachmentLink)})`)
  await send('switched file', 'Account reply: ')
  assert.equal(uploadAttempts, 1)
  assert.deepEqual(lastChatContent, [
    { type: 'text', text: 'Audit fixture content' },
    { type: 'text', text: 'switched file' },
  ])
  const mirroredId = await evaluate(`document.querySelector('[data-session-id] [aria-current="true"]').closest('[data-session-id]').dataset.sessionId`)
  const mirroredFile = await evaluate(`(async () => {
    const { workspace } = await fetch('/api/account/session').then((response) => response.json())
    const init = { headers: { 'X-AIHub-Workspace': workspace } }
    const path = '/api/account/sync/sessions/' + btoa(${JSON.stringify(mirroredId)}).replace(/=+$/, '')
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(path, init)
      if (response.ok) {
        const session = await response.json()
        const message = session.messages.find((item) => item.role === 'user' && item.content === 'switched file')
        if (session.messages.some((item) => item.role === 'assistant' && item.status === 'done' &&
            item.blocks.some((block) => block.text === 'Account reply: switched file')) && message?.files[0])
          return message.files[0].id
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  })()`, true)
  assert.ok(mirroredFile, 'The complete conversation and attachment reference must reach the account before changing browsers')

  invalidOpenAIKey = true
  await enterText('textarea', 'Invalid provider key')
  await click('button[aria-label="发送"]')
  await until(`document.body.textContent.includes('API Key 无效') && document.querySelector('textarea')`)
  assert.equal(await evaluate(signIn), false)
  invalidOpenAIKey = false

  const expiredChatId = await evaluate(`document.querySelector('[data-session-id] [aria-current="true"]').closest('[data-session-id]').dataset.sessionId`)
  await cdp('Network.clearBrowserCookies')
  await enterText('textarea', 'Expired account')
  await click('button[aria-label="发送"]')
  await until(`${signIn} && !document.querySelector('textarea')`)
  await clickText('button', '使用 Gitea 登录')
  await until(`document.querySelector('textarea') && document.querySelectorAll('[data-session-id]').length > 0`)
  await openProviders()
  await clickText('[role="tab"]', '账户管理')
  await clickText('[role="tabpanel"] button', '退出登录')
  await until(`${signIn} && !document.querySelector('textarea')`)
  await clickText('button', '使用 Gitea 登录')
  await until(`document.querySelector('textarea') && document.querySelectorAll('[data-session-id]').length > 0`)
  await clickText('button', '开启新对话')
  await click(chooser)
  await clickText('[role="option"]', 'deepseek-flash')
  const images = [['wide.png', 6000, 1500], ['edge.png', 4096, 512], ['tall.png', 1000, 5000]]
  const originalDigests = await attachImages(images)
  await send('sync original images', 'DeepSeek reply: ')
  assert.deepEqual(imageUploads.map(({ name, width, height }) => [name, width, height]).sort(), [
    ['edge.png', 4096, 512], ['tall.png', 819, 4096], ['wide.png', 4096, 1024],
  ])
  const uploadedIds = images.map(([name]) => imageUploads.find((image) => image.name === name).id)
  assert.deepEqual(imageReplies.at(-1), uploadedIds)
  assert.equal(imageUploads.find(({ name }) => name === 'edge.png').sha256, originalDigests['edge.png'])
  const imageChatId = await evaluate(`document.querySelector('[data-session-id] [aria-current="true"]').closest('[data-session-id]').dataset.sessionId`)
  const legacyChatId = 'legacy-synced-images'
  const legacyIds = ['file_legacy_wide', 'file_legacy_edge', 'file_legacy_tall']
  const sessionPath = (id) => '/api/account/sync/sessions/' + Buffer.from(id).toString('base64url')
  const waitForImageRecord = async (id, ready) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const record = await evaluate(`(async () => {
        const { workspace } = await fetch('/api/account/session').then(response => response.json())
        const response = await fetch(${JSON.stringify(sessionPath(id))}, { headers: { 'X-AIHub-Workspace': workspace } })
        return response.ok ? response.json() : null
      })()`, true)
      if (record && ready(record)) return record
      await sleep(100)
    }
    assert.fail('The image conversation did not sync to the account')
  }
  const imageRecord = await waitForImageRecord(imageChatId, (session) =>
    session.messages.some((message) => message.role === 'assistant' && message.status === 'done')
  )
  assert.deepEqual(imageRecord.messages[0].files.map(({ serverId, imageSizeChecked }) => [serverId, imageSizeChecked]),
    uploadedIds.map((id) => [id, true]))
  const legacyRecord = {
    ...imageRecord, id: legacyChatId, title: 'Legacy synced images',
    messages: [
      {
        ...imageRecord.messages[0],
        files: imageRecord.messages[0].files.map(({ imageSizeChecked, ...file }, index) =>
          ({ ...file, serverId: legacyIds[index] })
        ),
      },
      ...imageRecord.messages.slice(1),
    ],
  }
  assert.equal(await evaluate(`(async () => {
    const { workspace } = await fetch('/api/account/session').then(response => response.json())
    const response = await fetch(${JSON.stringify(sessionPath(legacyChatId))}, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json', 'X-AIHub-Workspace': workspace,
        'X-AIHub-Revision': '0', 'X-AIHub-Mutation': crypto.randomUUID(),
      },
      body: JSON.stringify(${JSON.stringify(legacyRecord)}),
    })
    return response.status
  })()`, true), 200)
  await clickText('button', '开启新对话')
  const unsentDraft = '跨设备草稿 🧪'
  await enterText('textarea', unsentDraft)
  await openProviders()
  await clickText('[role="tab"]', '通用设置')
  assert.equal(
    await evaluate('document.querySelector(\'[role="tabpanel"]\').lastElementChild?.textContent'),
    '版本号v' + version
  )
  await clickText('[role="radio"]', '深色')
  await clickText('[role="tab"]', '数据管理')
  const remotePreferencesAndDraft = await evaluate(`(async () => {
    const { workspace } = await fetch('/api/account/session').then((response) => response.json())
    const init = { headers: { 'X-AIHub-Workspace': workspace } }
    const token = (value) => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const fetchRecord = async (kind, id) => {
      const response = await fetch('/api/account/sync/' + kind + '/' + token(id), init)
      return response.ok ? response.json() : null
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      const theme = await fetchRecord('settings', 'themePreference')
      const draft = await fetchRecord('drafts', ':new-chat')
      const session = await fetchRecord('sessions', ${JSON.stringify(expiredChatId)})
      const expiredMessage = session?.messages.find(
        (message) => message.role === 'user' && message.content === 'Expired account'
      )
      const settledReply = expiredMessage && session.messages.some((message) =>
        message.role === 'assistant' && message.parentId === expiredMessage.id &&
        (message.status === 'stopped' || message.status === 'error')
      )
      if (theme?.value === 'dark' && draft?.text === ${JSON.stringify(unsentDraft)} && settledReply) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })()`, true)
  assert.ok(remotePreferencesAndDraft, 'Preferences, draft, and the interrupted reply must reach the account after signing back in')
  try {
    await until(`document.querySelector('[role="tabpanel"] [role="status"]')?.textContent === '已同步' && document.body.classList.contains('dark')`, 8000)
  } catch (error) {
    const state = await evaluate(`(async () => {
      const { workspace } = await fetch('/api/account/session').then((response) => response.json())
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ai-hub:workspace:' + workspace)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = (store) => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [mutations, sessions, versions] = await Promise.all(
        ['syncMutations', 'sessions', 'syncVersions'].map(read)
      )
      db.close()
      return {
        dark: document.body.classList.contains('dark'),
        pending: mutations.map(({ kind, id, baseRevision, deleted }) => ({
          kind, id, baseRevision, deleted,
          replies: sessions.find((session) => session.id === id)?.messages
            .filter((message) => message.role === 'assistant').map((message) => message.status),
        })),
        cursor: versions.find((version) => version.key === 'changes-cursor')?.revision,
      }
    })()`, true)
    throw new Error(error.message + '\nWorkspace status: ' + JSON.stringify(state))
  }
  await closeSettings()
  await until(`!document.querySelector('[role="dialog"]')`)
  await click('button[aria-label="设置"][aria-haspopup="menu"]')
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some(node => node.textContent.trim() === '退出登录')`)
  await clickText('[role="menuitem"]', '退出登录')
  await until(`${signIn} && !document.querySelector('textarea')`)

  // Sign in with the same account in a browser with no site data.
  await cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  await cdp('Page.reload', { ignoreCache: true })
  await until(signIn)
  assert.equal(await evaluate(`localStorage.getItem('ai-hub:providers')`), null)
  await clickText('button', '使用 Gitea 登录')
  await until(`document.querySelector('textarea')?.value === ${JSON.stringify(unsentDraft)} && document.body.classList.contains('dark')`)
  const openImageChat = async (id) => {
    const selector = `[data-session-id="${id}"] > button`
    await until(`document.querySelector(${JSON.stringify(selector)})`)
    await click(selector)
    for (const [name, width, height] of images) {
      await until(`(() => {
        const image = document.querySelector(${JSON.stringify(`img[alt="${name}"]`)})
        return image?.naturalWidth === ${width} && image.naturalHeight === ${height}
      })()`)
    }
  }
  await openImageChat(imageChatId)
  assert.deepEqual(await evaluate(`(async () => {
    const digests = {}
    for (const name of ${JSON.stringify(images.map(([name]) => name))}) {
      const image = document.querySelector('img[alt="' + name + '"]')
      const original = await fetch(image.src).then(response => response.arrayBuffer())
      const sha = await crypto.subtle.digest('SHA-256', original)
      digests[name] = Array.from(new Uint8Array(sha), byte => byte.toString(16).padStart(2, '0')).join('')
    }
    return digests
  })()`, true), originalDigests)
  await send('continue with checked images', 'DeepSeek reply: ')
  assert.deepEqual(imageReplies.at(-1), uploadedIds)
  assert.equal(imageUploads.length, 3)
  await openImageChat(legacyChatId)
  await send('continue with legacy images', 'DeepSeek reply: ')
  const reuploads = imageUploads.slice(3)
  assert.deepEqual(reuploads.map(({ name, width, height }) => [name, width, height]).sort(), [
    ['tall.png', 819, 4096], ['wide.png', 4096, 1024],
  ])
  const updatedIds = [reuploads.find(({ name }) => name === 'wide.png').id, legacyIds[1],
    reuploads.find(({ name }) => name === 'tall.png').id]
  assert.deepEqual(imageReplies.at(-1), updatedIds)
  await waitForImageRecord(legacyChatId, (session) =>
    session.messages[0].files.every((file) => file.imageSizeChecked)
  )
  await evaluate('window.beforeImageReload = true')
  await cdp('Page.reload', { ignoreCache: true })
  await until('!window.beforeImageReload && Boolean(document.querySelector("textarea"))')
  await openImageChat(legacyChatId)
  await send('reuse migrated image IDs after reload', 'DeepSeek reply: ')
  assert.deepEqual(imageReplies.at(-1), updatedIds)
  assert.equal(imageUploads.length, 5)
  const mirroredChat = `[data-session-id="${mirroredId}"] > button`
  await until(`document.querySelector(${JSON.stringify(mirroredChat)})`)
  await click(mirroredChat)
  await until(`document.body.textContent.includes('Account reply: switched file') && document.body.textContent.includes('provider-switch.txt')`)
  await until(`document.querySelector(${JSON.stringify(textAttachmentLink)})`)
  assert.deepEqual(await evaluate(`(async () => {
    const file = await fetch(document.querySelector(${JSON.stringify(textAttachmentLink)}).href).then(response => response.blob())
    return { type: file.type, text: await file.text() }
  })()`, true), { type: 'application/octet-stream', text: 'Audit fixture content' })
  const restoredFile = await evaluate(`(async () => {
    const { workspace } = await fetch('/api/account/session').then((response) => response.json())
    const connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-hub:workspace:' + workspace)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const file = await new Promise((resolve, reject) => {
        const request = connection.transaction('files').objectStore('files').get(${JSON.stringify(mirroredFile)})
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return file && { type: file.blob.type, text: await file.blob.text() }
    } finally {
      connection.close()
    }
  })()`, true)
  assert.deepEqual(restoredFile, { type: 'text/plain', text: 'Audit fixture content' })

  const fixtureSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>'
  await evaluate(`(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['%PDF-1.4'], 'draft-preview.pdf', { type: 'text/plain' }))
    transfer.items.add(new File([${JSON.stringify(fixtureSvg)}], 'draft-download.svg', { type: 'text/plain' }))
    const input = document.querySelector('input[type="file"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`document.querySelector('a[aria-label="draft-preview.pdf"][target="_blank"]') &&
    document.querySelector('a[download="draft-download.svg"] img')?.naturalWidth === 12`)
  assert.deepEqual(await evaluate(`(async () => {
    const pdf = document.querySelector('a[aria-label="draft-preview.pdf"]')
    const svg = document.querySelector('a[download="draft-download.svg"]')
    const file = await fetch(svg.href).then(response => response.blob())
    return [(await fetch(pdf.href)).headers.get('content-type'), pdf.rel,
      svg.querySelector('img').src.startsWith('data:image/svg+xml;'), svg.target, file.type, await file.text()]
  })()`, true), ['application/pdf', 'noreferrer', true, '', 'application/octet-stream', fixtureSvg])
  await click('[title="draft-preview.pdf"] button[aria-label="删除"]')
  await click('[title="draft-download.svg"] button[aria-label="删除"]')

  await openProviders()
  assert.equal(await evaluate(`document.querySelector('[role="tabpanel"]').textContent.includes('仅浏览器')`), false)
  await closeSettings()
  await until(`!document.querySelector('[role="dialog"]')`)
  await clickText('button', '开启新对话')
  await click(chooser)
  await clickText('[role="option"]', '使用默认模型')
  await send('clean browser', 'Account reply: ')
  assert.deepEqual(upstream, { model: 'fixture-default-outside-catalog', auth: 'Bearer ' + rotatedKey })

  await evaluate(`(async () => {
    const older = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo', 11)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) db.createObjectStore(name, { keyPath: 'id' })
        db.createObjectStore('sessionSummaries', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = older.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
    const summary = { id: 'old-local-chat', title: '升级前的会话', createdAt: 1672500000000, updatedAt: 1672500000100, pinned: true }
    const name = 'upgrade-note.txt'
    const blob = new Blob(['旧版附件'], { type: 'text/plain' })
    const file = { id: 'old-attachment', name, size: blob.size, mimeType: 'text/plain', isImage: false, serverId: null }
    tx.objectStore('sessions').put({ ...summary, messages: [{ id: 'old-message', role: 'user', createdAt: summary.createdAt, content: '保留这条会话', files: [file] }] })
    tx.objectStore('sessionSummaries').put({ ...summary, fileIds: [file.id] })
    tx.objectStore('files').put({ id: file.id, blob })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    older.close()
  })()`, true)

  await openProviders()
  await clickText('[role="tab"]', '数据管理')
  await until(`[...document.querySelectorAll('[role="tabpanel"] button')].some((button) => button.textContent.trim() === '合并')`)
  await clickText('[role="tabpanel"] button', '合并')
  await until(`document.body.textContent.includes('已合并 1 个会话') && document.querySelector('[data-session-id="old-local-chat"]')`)
  await clickText('[role="tabpanel"] button', '合并')
  await until(`document.body.textContent.includes('已合并 0 个会话')`)
  await viewport(320, 680, true)
  await until(`document.querySelector(${JSON.stringify(workspaceStorage)}) && innerWidth === 320`)
  assert.equal(await evaluate(`(() => {
    const panel = document.querySelector('[role="tabpanel"]')
    return panel.scrollWidth === panel.clientWidth
  })()`), true)
  await viewport(1100, 760, false)
  await click(workspaceStorage)
  await clickText('[role="option"]', '仅此浏览器')
  await until(`document.querySelector('textarea') && !document.querySelector(${JSON.stringify(mirroredChat)}) && !document.querySelector('[role="dialog"]')`)
  await click(chooser)
  await clickText('[role="option"]', '使用默认模型')
  await send('local workspace', 'Account reply: ')
  const localChatId = await evaluate(`document.querySelector('[data-session-id] [aria-current="true"]').closest('[data-session-id]').dataset.sessionId`)
  await openProviders()
  await clickText('[role="tab"]', '数据管理')
  await click(workspaceStorage)
  await clickText('[role="option"]', '账号同步')
  await until(`document.querySelector(${JSON.stringify(mirroredChat)})`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-session-id]'), row => row.dataset.sessionId).includes(${JSON.stringify(localChatId)})`), false)

  // Simulate the connection dropping before a rename reaches the account, then
  // a successful edit from a second device using the current server revision.
  await evaluate(`(async () => {
    window.workspaceFetch = window.fetch
    window.workspaceFixtureRequest = async (url, init) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = await window.workspaceFetch(url, init)
        if (response.status !== 429) return response
        await response.text()
        await new Promise(resolve => setTimeout(resolve, 75))
      }
      throw new Error('Workspace still busy when simulating a second device')
    }
    const { workspace } = await window.workspaceFetch('/api/account/session').then((response) => response.json())
    const id = btoa(${JSON.stringify(mirroredId)}).replace(/=+$/, '')
    const endpoint = '/api/account/sync/sessions/' + id
    const headers = { 'X-AIHub-Workspace': workspace }
    const response = await window.workspaceFixtureRequest(endpoint, { headers })
    const revision = response.headers.get('X-AIHub-Revision')
    if (!response.ok || !revision) throw new Error('Could not read the workspace revision: ' + response.status)
    window.workspaceConflict = { endpoint, headers, revision, value: await response.json() }
    window.fetch = (url, init) => String(url).startsWith('/api/account/sync/')
      ? Promise.reject(new TypeError('Fixture lost connectivity'))
      : window.workspaceFetch(url, init)
  })()`, true)
  await click(`[data-session-id="${mirroredId}"] button[aria-label="更多"]`)
  await clickText('[role="menuitem"]', '重命名')
  await until(`document.querySelector('input[class*="renameInput"]')`)
  await enterText('input[class*="renameInput"]', '离线设备改名')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector(${JSON.stringify(mirroredChat)})?.textContent.includes('离线设备改名')`)
  assert.equal(await evaluate(`(async () => {
    const { endpoint, headers, revision, value } = window.workspaceConflict
    const response = await window.workspaceFixtureRequest(endpoint, {
      method: 'PUT',
      headers: { ...headers, 'X-AIHub-Revision': revision, 'X-AIHub-Mutation': crypto.randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...value, title: '另一设备改名', pinned: true }),
    })
    window.fetch = window.workspaceFetch
    window.dispatchEvent(new Event('online'))
    return response.status
  })()`, true), 200)
  await until(`document.querySelector(${JSON.stringify(mirroredChat)})?.textContent.includes('另一设备改名') &&
    [...document.querySelectorAll('[data-session-id]')].some((row) => row.textContent.includes('离线设备改名（冲突副本）'))`)
  await click(mirroredChat)
  await until(`document.body.textContent.includes('Account reply: switched file') && document.body.textContent.includes('provider-switch.txt')`)

  // A previous build may have written the empty stock provider when another provider was saved.
  const placeholder = {
    id: 'deepseek-default',
    name: 'DeepSeek',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    apiKey: '',
    scope: 'legacy-deepseek',
  }
  const draft = {
    ...placeholder,
    id: 'explicit-browser-provider',
    name: '未配置的本地 DeepSeek',
    scope: 'explicit-browser-scope',
  }
  const cleanProviderStorage = await providerStorageKey()
  await evaluate(`localStorage.setItem(${JSON.stringify(cleanProviderStorage)}, ${JSON.stringify(JSON.stringify([placeholder, draft]))})`)
  await cdp('Page.reload', { ignoreCache: true })
  await openProviders(3)
  assert.equal(await evaluate(`document.querySelector('[role="tabpanel"]').textContent.split('仅浏览器').length - 1`), 1)
  assert.equal(await evaluate(`Boolean(document.querySelector('button[aria-label="编辑 ${draft.name}"]'))`), true)
  await closeSettings()
  await until(`!document.querySelector('[role="dialog"]')`)
  await clickText('button', '开启新对话')
  await click(chooser)
  await clickText('[role="option"]', '使用默认模型')
  await send('render widgets', 'Account reply: ')
  await until(`document.querySelector('.katex .katex-html') && document.querySelector('.md-mermaid-diagram svg')?.textContent.includes('Start')`)

  const searchButton = 'button[aria-label="搜索对话"]'
  await click(searchButton)
  await until('document.activeElement === document.querySelector("dialog input")')
  assert.deepEqual(await evaluate(`(() => {
    const dialog = document.querySelector('dialog')
    const backdrop = getComputedStyle(dialog, '::backdrop')
    return [getComputedStyle(dialog).animationDuration, backdrop.backdropFilter, backdrop.animationName]
  })()`), ['0.15s', 'blur(4px)', 'none'])
  await enterText('dialog input', 'render widgets')
  await until('document.querySelector("dialog [role=option][aria-selected=true]")')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until('!document.querySelector("dialog") && document.body.textContent.includes("Account reply: render widgets")')

  await openProviders(3)
  assert.deepEqual(await evaluate(`(() => {
    const overlay = document.querySelector('[data-modal-overlay]')
    const style = getComputedStyle(overlay)
    const dialog = getComputedStyle(overlay.querySelector('[role=dialog]'))
    return [style.animationName, style.backdropFilter, dialog.animationDuration]
  })()`), ['none', 'none', '0.15s'])
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 })
  await until('!document.querySelector("[role=dialog]")')

  // A malformed canonical archive fails after staging without replacing the existing workspace.
  const openData = async (waitForSync = true) => {
    await openProviders(3)
    await clickText('[role="tab"]', '数据管理')
    if (waitForSync) await until("document.querySelector('[role=tabpanel] [role=status]')?.textContent === '已同步'", 12000)
  }
  const selectArchive = async (name, data) => {
    const file = join(directory, name)
    await writeFile(file, data)
    const { root } = await cdp('DOM.getDocument')
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '[role="tabpanel"] input[accept*=".zip"]' })
    assert.ok(nodeId)
    await cdp('DOM.setFileInputFiles', { nodeId, files: [file] })
    await until("document.body.textContent.includes('确认导入历史对话？')")
    await clickText('[role="dialog"] button', '确认导入')
  }
  const providerId = await evaluate("(async () => (await fetch('/api/account/session').then(r => r.json())).providers.find(p => p.protocol === 'deepseek').id)()", true)
  const connection = { providerId, model: 'deepseek-flash' }
  await openData()
  await selectArchive('invalid-history.zip', makeHistoryZip(connection, { interleaved: false, badIndex: true }))
  await until("document.querySelector('[role=tabpanel]').textContent.includes('文件导入失败')", 8000)
  assert.ok(await evaluate("document.body.textContent.includes('另一设备改名')"))
  assert.equal(await evaluate("document.querySelector('[data-session-id=archive-restored]') !== null"), false)

  // Import and sign-in also work without the modern browser APIs replaced by this release.
  const legacyApis = `delete Array.prototype.toSorted; delete Array.prototype.toReversed;
    delete AbortSignal.prototype.throwIfAborted; delete AbortSignal.prototype.reason;
    delete AbortSignal.any; delete AbortSignal.timeout;`
  await evaluate(legacyApis)
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: legacyApis })
  await evaluate(`(() => {
    const slice = File.prototype.slice
    File.prototype.slice = function(start, end, type) {
      const blob = slice.call(this, start, end, type)
      if (this.name === 'valid-history.zip' && start >= 512 * 1024 && end < this.size && !window.resumeHistoryImport) {
        const proceed = new Promise(resolve => { window.resumeHistoryImport = resolve })
        const arrayBuffer = blob.arrayBuffer.bind(blob)
        blob.arrayBuffer = async () => { await proceed; return arrayBuffer() }
      }
      return blob
    }
  })()`)
  await selectArchive('valid-history.zip', makeHistoryZip(connection, { interleaved: true }))
  const importing = "window.resumeHistoryImport && document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '32'"
  await until(importing, 8000)
  assert.equal(await evaluate("document.querySelector('[role=progressbar]').getAttribute('aria-valuemax')"), String(historySessionCount))
  await closeSettings()
  await until("!document.querySelector('[role=dialog]')")
  await openData(false)
  await until(importing)
  await evaluate('window.resumeHistoryImport()')
  await until("document.querySelector('[role=tabpanel]').textContent.includes('已导入 " + historySessionCount + " 个对话')", 12000)
  await until("document.querySelector('[role=tabpanel] [role=status]')?.textContent === '已同步'", 18000)
  await closeSettings()
  await until("!document.querySelector('[role=dialog]')")

  const archivedChat = '[data-session-id="' + historySessionId + '"] > button'
  const image = 'img[alt="archive-picture.png"]'
  const documentLink = 'a[aria-label="archive-proof.txt"][download]'
  const readImported = async () => {
    await until('document.querySelector(' + JSON.stringify(archivedChat) + ')', 18000)
    await click(archivedChat)
    await until('document.querySelector(' + JSON.stringify(image) + ')?.naturalWidth === 2')
    await until('document.querySelector(' + JSON.stringify(documentLink) + ')')
    return evaluate(`(async () => {
      const documentBlob = await fetch(document.querySelector(${JSON.stringify(documentLink)}).href).then(response => response.blob())
      const pictureBytes = await fetch(document.querySelector(${JSON.stringify(image)}).src).then(response => response.arrayBuffer())
      const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('')
      const { workspace } = await fetch('/api/account/session').then(response => response.json())
      const storage = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ai-hub:workspace:' + workspace)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const stored = await new Promise((resolve, reject) => {
        const request = storage.transaction('files').objectStore('files').get('archive-text')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      storage.close()
      return {
        documentMime: stored.blob.type,
        downloadMime: documentBlob.type,
        documentSize: documentBlob.size,
        documentDigest: await digest(await documentBlob.arrayBuffer()),
        imageDigest: await digest(pictureBytes),
      }
    })()`, true)
  }
  const expectedOriginals = {
    documentMime: 'text/plain',
    downloadMime: 'application/octet-stream',
    documentSize: historyFileSize,
    documentDigest: createHash('sha256').update(Buffer.alloc(historyFileSize, 65)).digest('hex'),
    imageDigest: createHash('sha256').update(historyPicture).digest('hex'),
  }
  assert.deepEqual(await readImported(), expectedOriginals)
  const archivedRecord = await waitForImageRecord(historySessionId, (session) => session.messages.length === 1)
  assert.equal(archivedRecord.pinned, true)
  assert.deepEqual(archivedRecord.connection, connection)

  await cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  await cdp('Page.reload', { ignoreCache: true })
  await until(signIn)
  await clickText('button', '使用 Gitea 登录')
  assert.deepEqual(await readImported(), expectedOriginals)
})
