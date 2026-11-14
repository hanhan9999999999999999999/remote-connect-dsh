/**
 * 可访问性守卫：用一个小渲染器把 client.js 的组件树摊平，检查
 *   · 标签栏是不是 ARIA tabs 模式（tablist / tab / tabpanel、roving tabIndex、键盘切换）
 *   · 开关与勾选项有没有 role + aria-checked
 *   · 加载态、错误态、提示条有没有被读屏器感知的 role
 *   · 有没有「能点但键盘够不着」的裸元素
 * 不依赖 react-dom，也不改 client.js 的运行时行为。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/* ---------------------------------------------------------------- 假 React */

// useState 的「预置值」队列：第一个元素给 tab，第二个给 status……用完就退回默认值。
// 有了它，就能在同一次测试里既看加载态、也看加载完成后的面板。
let seed = []
const createContext = (value) => {
  // Provider 与 context 是同一个盒子，渲染器改它的 value，useContext 读它
  const box = { value }
  box.Provider = { __provider: box }
  return box
}

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (c) => {
      if (Array.isArray(c)) c.forEach(push)
      else if (c !== undefined && c !== null && c !== false && c !== true) flat.push(c)
    }
    push(children)
    return { type, props: { ...(props || {}), children: flat } }
  },
  createContext,
  useContext: (box) => (box ? box.value : null),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => {
    const preset = seed.length ? seed.shift() : undefined
    return [preset !== undefined ? preset : typeof v === 'function' ? v() : v, () => {}]
  },
  Fragment: 'Fragment',
}

/* ---------------------------------------------------- 把 client.js 跑起来 */

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (opts) => (captured = opts) } },
  document: undefined,
  navigator: { language: 'zh-CN', clipboard: null },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
}
vm.runInNewContext(src, sandbox)
assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')

const bundle = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

const slots = []
bundle.apply({
  locale: { bind: (ns) => (k) => `${ns}:${k}`, register: () => {} },
  effect: (fn) => {
    fn()
    return () => {}
  },
  slots: {
    inject: (_n, fn) => fn(),
    register: (opts, component) => {
      slots.push({ opts, component })
      return () => {}
    },
  },
})

const section = slots.find((s) => s.opts.name === 'settings.section')
assert.ok(section, 'settings.section 没有注册')

/* ---------------------------------------------------------------- 渲染器 */

function renderTree(preset = []) {
  seed = [...preset]
  const tree = []
  const render = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) {
      node.forEach(render)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      tree.push({ type: '#text', props: { text: String(node) } })
      return
    }
    const { type, props } = node
    const children = (props && props.children) || []
    if (type && type.__provider) {
      const box = type.__provider
      const prev = box.value
      box.value = props.value
      render(children)
      box.value = prev
      return
    }
    if (typeof type === 'function') {
      render(type(props))
      return
    }
    tree.push({ type, props })
    render(children)
  }
  render(section.component({ t: (k) => k }))
  return tree
}

const byRole = (tree, role) => tree.filter((n) => n.props && n.props.role === role)
const classNameIs = (tree, cls) => tree.filter((n) => n.props && n.props.className === cls)

/* 1. 加载态（还没拿到 /status） --------------------------------------- */

const loadingTree = renderTree([])
const tablist = byRole(loadingTree, 'tablist')[0]
assert.ok(tablist, '找不到 role="tablist" 的标签栏')
assert.equal(typeof tablist.props.onKeyDown, 'function', '标签栏没有键盘处理（左右键切不了）')

const tabs = byRole(loadingTree, 'tab')
assert.equal(tabs.length, 5, `标签数量应为 5，实际 ${tabs.length}`)
for (const tab of tabs) {
  const id = tab.props.id
  assert.ok(id && id.startsWith('dlk-tab-'), `标签缺少 id：${JSON.stringify(tab.props)}`)
  assert.equal(typeof tab.props['aria-selected'], 'boolean', `${id} 缺少 aria-selected`)
  assert.equal(tab.props['aria-controls'], id.replace('dlk-tab-', 'dlk-panel-'), `${id} 的 aria-controls 对不上`)
  assert.ok([0, -1].includes(tab.props.tabIndex), `${id} 的 tabIndex 应为 roving 的 0/-1`)
}
assert.equal(tabs.filter((t) => t.props.tabIndex === 0).length, 1, '同一时刻只能有一个标签在 Tab 序列里')
assert.equal(tabs.filter((t) => t.props['aria-selected']).length, 1, '只能有一个标签被选中')

let prevented = false
try {
  tablist.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => (prevented = true) })
} catch {
  // go() 会顺手打一个 /config 请求，测试环境没有 fetch，报错不影响断言
}
assert.ok(prevented, '按右方向键没有接管事件（应该 preventDefault 后切到下一个标签）')

const loading = classNameIs(loadingTree, 'dlk-empty')[0]
assert.ok(loading, '第一次渲染应该有加载态')
assert.ok(['status', 'alert'].includes(loading.props.role), '加载态缺少 role="status"')
for (const spin of classNameIs(loadingTree, 'dlk-spin')) {
  assert.equal(spin.props['aria-hidden'], 'true', '转圈图标应该 aria-hidden（读屏器读「加载中」就够了）')
}

/* 2. 拿到 /status 之后（面板出来了） --------------------------------- */

const statusFixture = {
  config: {
    device: { name: 'node-A', id: 'abc123def456' },
    server: { running: true, port: 33204, enabled: true, discovery: true, addresses: [] },
    auth: { password: 'ABCD2345EFGH' },
    sync: { categories: {} },
    connectUri: 'dshlink://node-A:33204?pwd=ABCD2345EFGH',
  },
  server: { running: true, port: 33204 },
  peers: [],
  recent: [],
}
const loadedTree = renderTree([undefined, statusFixture, null, null])
const panel = byRole(loadedTree, 'tabpanel')[0]
assert.ok(panel, '拿到 /status 之后应该渲染 role="tabpanel" 的面板')
const liveTabs = byRole(loadedTree, 'tab')
const active = liveTabs.find((t) => t.props['aria-selected'])
assert.ok(active, '面板出来以后应该有选中的标签')
assert.equal(panel.props.id, active.props['aria-controls'], '面板 id 与选中标签的 aria-controls 不一致')
assert.equal(panel.props['aria-labelledby'], active.props.id, '面板没有指回选中它的标签')

/* 3. 开关 / 勾选 ------------------------------------------------------ */

const switches = loadedTree.filter((n) => n.props && (n.props.role === 'switch' || n.props.role === 'checkbox'))
assert.ok(switches.length > 0, '一个 switch / checkbox 都没有？')
for (const s of switches) {
  assert.equal(s.type, 'button', `${s.props.role} 应该用真的 button 建，才能被键盘触发`)
  assert.equal(typeof s.props['aria-checked'], 'boolean', `${s.props.role} 缺少 aria-checked`)
}

/* 4. 没有「能点却键盘够不着」的裸元素 ---------------------------------- */

const focusable = new Set(['button', 'a', 'input', 'select', 'textarea'])
for (const tree of [loadingTree, loadedTree]) {
  const traps = tree.filter(
    (n) => n.props && typeof n.props.onClick === 'function' && !focusable.has(n.type) && !n.props.role,
  )
  assert.deepEqual(
    traps.map((n) => n.props.className || n.type),
    [],
    '这些元素挂了 onClick 却既不是按钮也没有 role，键盘用户点不到',
  )
}

console.log(
  `a11y ok · 标签 ${liveTabs.length} 个（roving tabIndex + 方向键 + aria-controls） · 开关/勾选 ${switches.length} 个有 aria-checked · 加载态有 role`,
)
