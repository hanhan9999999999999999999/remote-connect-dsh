/**
 * dsh-remote-connect · framed stream transforms
 */
import { Transform } from 'node:stream'
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
