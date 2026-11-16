/**
 * Test helper: runs one LinkService in its own process with its own DSH_HOME.
 * Prints "READY <port>" once the HTTP service is listening.
 */
import { ConfigStore } from '../host/config.mjs'
import { LinkService } from '../host/service.mjs'
import { Logger } from '../host/util.mjs'

const port = Number(process.env.LINK_TEST_PORT)
const password = process.env.LINK_TEST_PASSWORD
const name = process.env.LINK_TEST_NAME || 'test-node'

const store = new ConfigStore()
await store.load()
await store.patch({
  server: { enabled: true, port, bind: '127.0.0.1', discovery: false },
  device: { name },
})
await store.setPassword(password)

const service = new LinkService({ store, logger: new Logger({}) })
await service.init()
const status = await service.status()
process.stdout.write(`READY ${status.server?.port ?? port}\n`)

const shutdown = async () => {
  try {
    await service.server?.stop?.()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setInterval(() => {}, 1 << 30)
