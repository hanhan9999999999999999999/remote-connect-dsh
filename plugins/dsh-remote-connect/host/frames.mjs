/**
 * dsh-remote-connect · framed stream transforms
 */
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { FrameDecoder, encodeFrame } from './crypto.mjs'

export class FrameEncoderTransform extends Transform {
  constructor(key) {
    super()
    this.key = key
    this.index = 0
  }
  _transform(chunk, _enc, cb) {
    try {
      cb(null, encodeFrame(this.key, this.index++, chunk))
    } catch (err) {
      cb(err)
    }
  }
}

export class FrameDecoderTransform extends Transform {
  constructor(key) {
    super()
    this.decoder = new FrameDecoder(key)
  }
  _transform(chunk, _enc, cb) {
    try {
      for (const out of this.decoder.push(chunk)) this.push(out)
      cb()
    } catch (err) {
      cb(err)
    }
  }
  _flush(cb) {
    try {
      this.decoder.end()
      cb()
    } catch (err) {
      cb(err)
    }
  }
}

/**
 * 把一条帧流接成「解密 → 解压」的管道。
 *
 * 这两环都必须有 error 监听：对端发来一段解不开的帧（或压缩流坏了）时，
 * Transform 会 emit('error')，没人接的话整个进程会被抛死。
 * 这里统一转成末尾那条流上的错误，让调用方的 pipeline / for-await 自然 reject。
 *
 * 返回的 `destroy()` 用来在失败或提前结束时收掉整条链路——
 * 否则对端还在往外传，socket 会一直挂在 agent 池里。
 */
export function decodeFrames(source, key) {
  const decoder = new FrameDecoderTransform(key)
  const gunzip = createGunzip()
  const stream = source.pipe(decoder).pipe(gunzip)
  const fail = (err) => {
    if (!stream.destroyed) stream.destroy(err)
  }
  decoder.on('error', fail)
  gunzip.on('error', fail)
  return {
    stream,
    destroy() {
      if (!source.destroyed) source.destroy()
      if (!stream.destroyed) stream.destroy()
    },
  }
}
