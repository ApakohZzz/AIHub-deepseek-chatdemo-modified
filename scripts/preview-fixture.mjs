import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:8090')
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-api-key')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.url === '/v1/models') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }] }))
    return
  }
  if (
    request.url !== '/v1/chat/completions' ||
    request.headers.authorization !== 'Bearer fixture-credential'
  ) {
    response.writeHead(404)
    response.end()
    return
  }
  let input = ''
  for await (const chunk of request) input += chunk
  const body = JSON.parse(input)
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  let closed = false
  response.on('close', () => {
    closed = true
  })
  const write = (delta) =>
    response.write(
      `data: ${JSON.stringify({ model: body.model, choices: [{ delta, finish_reason: null }] })}\n\n`
    )
  const reasoning = '先梳理需求，再按品牌、交互与模型接入三个部分检查。'
  for (const part of reasoning.match(/.{1,4}/gu) ?? []) {
    if (closed) return
    write({ reasoning_content: part })
    await delay(90)
  }
  const answer =
    '你好，我是 **AI Hub**。这是用于验证流式显示的本机测试响应。\n\n| 项目 | 状态 |\n| --- | --- |\n| 品牌与 Logo | 已更新 |\n| 多供应商 | 已接入 |\n| Markdown | 正常显示 |\n\n```ts\nconst message = "Hello, AI Hub"\nconsole.log(message)\n```\n\n你可以继续提问，或切换模型开始新的对话。'
  for (const part of answer.match(/.{1,5}/gsu) ?? []) {
    if (closed) return
    write({ content: part })
    await delay(55)
  }
  if (closed) return
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 65 } })}\n\ndata: [DONE]\n\n`
  )
  response.end()
})
server.listen(8091, '127.0.0.1', () => console.log('Fixture API http://127.0.0.1:8091/v1'))
process.on('SIGINT', () => server.close(() => process.exit(0)))
