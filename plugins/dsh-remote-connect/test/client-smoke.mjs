/**
 * Loads client.js the way the DSH web loader would, with a fake React and a
 * fake plugin context, and fails if the plugin does not register its section.
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (opts) => (captured = opts) } },
  document: undefined,
  navigator: { language: 'zh-CN', clipboard: null },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
}
vm.runInNewContext(src, sandbox)
if (!captured) throw new Error('client.js did not call __ModuleLoader__.load')

const React = {
  createElement: () => null,
  createContext: () => ({ Provider: 'Provider' }),
  useContext: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  Fragment: 'Fragment',
}

const bundle = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
if (typeof bundle.apply !== 'function') throw new Error('bundle.apply missing')

let dict = null
const slots = []
const ctx = {
  locale: {
    bind: (ns) => (key) => `${ns}:${key}`,
    register: (ns, d) => {
      dict = { ns, d }
    },
  },
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (opts, component) => {
      slots.push({ opts, component })
      return () => {}
    },
  },
}
bundle.apply(ctx)

const section = slots.find((s) => s.opts.name === 'settings.section')
if (!section) throw new Error('settings.section was not registered')
if (section.opts.id !== 'remote-connect') throw new Error('unexpected section id: ' + section.opts.id)
if (!dict || dict.ns !== 'deviceLink') throw new Error('locale dictionaries were not registered')
if (!dict.d.zh || !dict.d.en) throw new Error('zh/en dictionaries missing')

const zhKeys = Object.keys(dict.d.zh)
const enKeys = Object.keys(dict.d.en)
const missingEn = zhKeys.filter((k) => !(k in dict.d.en))
const missingZh = enKeys.filter((k) => !(k in dict.d.zh))
if (missingEn.length) throw new Error('missing English keys: ' + missingEn.slice(0, 8).join(', '))
if (missingZh.length) throw new Error('missing Chinese keys: ' + missingZh.slice(0, 8).join(', '))

console.log(`client ok · section=${section.opts.id} order=${section.opts.order} label=${section.opts.label()} · keys=${zhKeys.length} · slots=${slots.length}`)
