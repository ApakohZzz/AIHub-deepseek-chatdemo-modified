import { throwIfAborted } from '../../utils/abort.js'
import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'
import { hasProviderKey, type ProviderProfile } from '../providers.js'
import { speechLanguage, splitSpeechText } from './browserSpeech.js'

/**
 * 朗读：同一时间只读一条回复。
 * DeepSeek 使用 PCM 流，浏览器语音负责其他回复。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1

let current: { controller: AbortController; dispose: () => void } | null = null

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  const { dispose } = current
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
  dispose()
}

const startBrowserSpeech = (
  controller: AbortController,
  text: string,
  onError: (error: unknown) => void
) => {
  const synthesis = window.speechSynthesis
  const chunks = splitSpeechText(text)
  if (chunks.length === 0) {
    throw new ApiError('protocol', { key: 'ttsUnavailable' })
  }
  const failure = () => new ApiError('protocol', { key: 'ttsBrowserUnavailable' })
  if (!synthesis || typeof SpeechSynthesisUtterance !== 'function') {
    throw failure()
  }
  current = { controller, dispose: () => synthesis.cancel() }
  const { locale } = useSettings.getState()
  const voices = synthesis.getVoices()
  const speak = (index: number) => {
    if (controller.signal.aborted || current?.controller !== controller) {
      return
    }
    if (index === chunks.length) {
      finish(controller)
      return
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index])
    utterance.lang = speechLanguage(chunks[index], locale)
    const language = utterance.lang.split('-')[0]
    const voice =
      voices.find((item) => item.localService && item.lang === utterance.lang) ??
      voices.find((item) => item.localService && item.lang.split('-')[0] === language)
    if (voice) {
      utterance.voice = voice
    }
    utterance.onstart = () => {
      if (current?.controller === controller) {
        useReadAloud.setState({ status: 'playing' })
      }
    }
    utterance.onend = () => speak(index + 1)
    utterance.onerror = () => {
      if (current?.controller === controller && !controller.signal.aborted) {
        finish(controller)
        onError(failure())
      }
    }
    synthesis.speak(utterance)
  }
  speak(0)
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void,
  connection?: ProviderProfile
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const controller = new AbortController()
  useReadAloud.setState({ messageId, status: 'loading' })
  if (connection?.protocol !== 'deepseek' || !hasProviderKey(connection)) {
    try {
      startBrowserSpeech(controller, text, onError)
    } catch (error) {
      finish(controller)
      useReadAloud.setState({ messageId: null, status: 'idle' })
      onError(error)
    }
    return
  }
  let context: AudioContext
  try {
    context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  } catch (error) {
    useReadAloud.setState({ messageId: null, status: 'idle' })
    onError(error)
    return
  }
  current = { controller, dispose: () => void context.close().catch(() => {}) }
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { ttsVoice } = useSettings.getState()

  void (async () => {
    let nextTime = 0
    let started = false
    let sources = 0
    let ended = false
    let rest = new Uint8Array(0)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      await context.resume()
      throwIfAborted(controller.signal)
      const stream = await synthesize(
        connection.apiKey,
        text,
        ttsVoice,
        controller.signal,
        connection
      )
      const streamReader = stream.getReader()
      reader = streamReader
      controller.signal.addEventListener(
        'abort',
        () => void streamReader.cancel().catch(() => {}),
        { once: true }
      )
      for (;;) {
        const { done, value } = await reader.read()
        throwIfAborted(controller.signal)
        if (done) {
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        // 网络慢于播放时从当前时间续上，不补播过去的时间
        nextTime = Math.max(nextTime, context.currentTime + (started ? 0 : START_DELAY))
        sources += 1
        source.onended = () => {
          sources -= 1
          if (ended && sources === 0) {
            finish(controller)
          }
        }
        source.start(nextTime)
        nextTime += buffer.duration
        if (!started) {
          started = true
          useReadAloud.setState({ status: 'playing' })
        }
      }
      ended = true
      if (!started) {
        throw new ApiError('protocol', { key: 'ttsUnavailable' })
      }
      if (sources === 0) {
        finish(controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(controller)
        onError(error)
      }
    } finally {
      reader?.releaseLock()
    }
  })()
}
