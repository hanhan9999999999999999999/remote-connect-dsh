// 错误码 → HTTP 状态码。写死一张表，别的模块新加错误码时默认 500（并且会带可读 message），
// 不会因为漏了一个分支就把「内容太大」这种可操作的事说成「服务端坏了」。
//
// 单独一个模块：本机路由层（index.js）和 P2P 服务端（host/server.mjs）都要用同一张表，
// 放进 index.js 会绕成循环依赖。

export const STATUS = {
  // 认证
  BAD_PASSWORD: 401,
  LOCKED_OUT: 401,
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,
  MISSING_SIGNATURE: 401,
  BAD_SIGNATURE: 401,
  REPLAY: 401,
  CLOCK_SKEW: 401,
  LOCKED: 429,
  // 权限 / 密钥不符
  KEY_MISMATCH: 403,
  // 找不到
  PEER_UNKNOWN: 404,
  TASK_UNKNOWN: 404,
  SYNC_UNKNOWN: 404,
  PACK_UNKNOWN: 404,
  NOT_FOUND: 404,
  // 状态冲突（做不了，但不是参数错）
  NOT_CONNECTED: 409,
  NEED_PASSWORD: 409,
  NO_PASSWORD: 409,
  PORT_IN_USE: 409,
  SYNC_BUSY: 409,
  NO_JOURNAL: 409,
  ALREADY_ROLLED_BACK: 409,
  // 参数 / 内容不对
  BAD_INPUT: 400,
  BAD_JSON: 400,
  NO_HOST: 400,
  METHOD: 400,
  CATEGORY: 400,
  EMPTY: 400,
  BAD_PLUGIN_ID: 400,
  PATH_ESCAPE: 400,
  VERSION_MISMATCH: 400,
  HASH_MISMATCH: 400,
  SIZE_MISMATCH: 400,
  // 太大
  TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  BODY_TOO_LARGE: 413,
  // 对端的问题（网关类）
  NETWORK: 502,
  TIMEOUT: 502,
  NOT_DSH_LINK: 502,
  BAD_RESPONSE: 502,
  BAD_ENVELOPE: 502,
  PHONE_BAD_RESPONSE: 502,
  NO_PORT: 502,
  // 本机写盘失败（盘满、配额、临时文件删不掉）——不是对端的错，也不该被当成 400
  WRITE_FAILED: 500,
  READ_FAILED: 500,
}

export function statusFor(code) {
  return STATUS[code] ?? 500
}
