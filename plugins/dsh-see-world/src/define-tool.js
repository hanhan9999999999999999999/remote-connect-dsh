/**
 * define-tool.js — 拿宿主的 `defineTool`，拿不到就自己编译一份等价的。
 *
 * 为什么要兜底：`@deepseek-ai/dsh-tools` 是打进 `app.asar` 的，插件侧 `import` 它
 * 常常解析不到。而 `apply()` 外面包着 catch —— 这里抛出去，插件会**静默不注册**，
 * 表现是"工具列表里没有它"，最难查的一类问题。
 *
 * 编译规则（宿主 author spec 的约定）：
 *   - `parameters` 是「属性名 → 值 schema」映射，不是完整 JSON Schema
 *   - 属性里的 `required:true` 要提升到父级 `required` 数组，并从这里删掉
 *   - `type:'json'` 不是标准 JSON Schema 类型，退化成"不写 type"
 */

function clean(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'required' && v === true) continue;   // 已在父级表达
    out[k] = (v && typeof v === 'object') ? clean(v) : v;
  }
  if (out.type === 'json') delete out.type;
  return out;
}

export function parametersToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    const s = { ...(spec ?? {}) };
    if (s.required === true) required.push(name);
    delete s.required;
    properties[name] = clean(s);
  }
  const out = { type: 'object', properties, additionalProperties: false };
  if (required.length) out.required = required;
  return out;
}

export function outputSchemaToJsonSchema(output = {}) {
  // 先在**原始** schema 上把 `required:true` 提升到父级 —— 不能先 clean：
  // clean() 会把 `required:true` 这种布尔标记当作"已在父级表达"删掉，
  // 删完再找就永远找不到（曾经这里输出的 required 是空的）。
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { node.forEach(walk); return node; }
    if (node.properties && typeof node.properties === 'object') {
      const req = [];
      for (const [k, v] of Object.entries(node.properties)) {
        if (v && v.required === true) { req.push(k); delete v.required; }
        walk(v);
      }
      if (req.length) node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...req])];
    }
    return node;
  };
  return clean(walk(JSON.parse(JSON.stringify(output?.schema ?? { type: 'object' }))));
}

function assertSpec(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options 必须是对象');
  if (!options.name || typeof options.name !== 'string') throw new Error('defineTool: 缺 name');
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}): 缺 execute`);
  if (!options.output || typeof options.output.render !== 'function') {
    throw new Error(`defineTool(${options.name}): 缺 output.render`);
  }
  if (!(options.timeoutMs > 0)) throw new Error(`defineTool(${options.name}): timeoutMs 必须是正数`);
}

/**
 * 自己编译一份宿主形状的工具对象。
 * 字段名对齐宿主（`inputSchema` / `outputSchema` / `handler`）——多写一份别名不花钱。
 */
export function defineToolCompat(options) {
  assertSpec(options);
  const inputSchema = parametersToJsonSchema(options.parameters);
  const outputSchema = outputSchemaToJsonSchema(options.output);
  const timeoutMs = options.timeoutMs;
  const isConcurrencySafe = typeof options.isConcurrencySafe === 'function'
    ? options.isConcurrencySafe.bind(options)
    : () => false;

  return {
    name: options.name,
    description: options.description ?? '',
    parameters: options.parameters ?? {},
    inputSchema,
    outputSchema,
    output: options.output,
    timeoutMs,
    isConcurrencySafe,
    execute: options.execute,
    handler: options.execute,     // 宿主两个名字都用过
    route: options.route,
    render: options.output.render,
  };
}

/** 拿宿主的 `defineTool`；拿不到用上面的兜底。 */
export async function loadDefineTool({ log = () => {} } = {}) {
  const fromEnv = process.env.DSH_TOOLS_PATH;
  for (const target of ['@deepseek-ai/dsh-tools', fromEnv].filter(Boolean)) {
    try {
      const mod = await import(target);
      const fn = mod?.defineTool ?? mod?.default?.defineTool ?? mod?.default;
      if (typeof fn === 'function') return fn;
    } catch (e) {
      log(`import(${target}) 不行：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  return defineToolCompat;
}
