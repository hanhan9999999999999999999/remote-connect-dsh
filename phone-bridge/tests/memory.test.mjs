// 记忆提炼解析的单元测试：模型输出格式千奇百怪，这里把见过的都钉住。
// 运行：node tests/memory.test.mjs
import { parseFacts } from '../memory.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};

eq('纯数组', parseFacts('["主人喜欢喝冰美式","她最近在赶项目"]'),
  ['主人喜欢喝冰美式', '她最近在赶项目']);

eq('```json 围栏', parseFacts('好的，我提炼如下：\n```json\n["主人怕冷","晚上容易犯困"]\n```\n以上。'),
  ['主人怕冷', '晚上容易犯困']);

eq('前后有解释文字', parseFacts('结果：["主人养了一只猫","猫叫大肥鱼"] 希望有帮助'),
  ['主人养了一只猫', '猫叫大肥鱼']);

eq('包成对象', parseFacts('{"facts":["主人是程序员","她喜欢深夜工作"]}'),
  ['主人是程序员', '她喜欢深夜工作']);

eq('空数组', parseFacts('[]'), []);
eq('没有 JSON', parseFacts('我觉得没什么好记的'), []);
eq('坏 JSON', parseFacts('["没闭合"'), []);
eq('非数组', parseFacts('{"a":1}'), []);
eq('过滤非字符串和太短的', parseFacts('["ab","这是一条合格的事实",3,null]'), ['这是一条合格的事实']);
eq('压缩空白', parseFacts('["  主人   今天   很累  "]'), ['主人 今天 很累']);
eq('最多 6 条', parseFacts(JSON.stringify(['第一条事实','第二条事实','第三条事实','第四条事实','第五条事实','第六条事实','第七条事实'])).length, 6);
eq('中文引号里的方括号不干扰', parseFacts('说明[1]：["主人喜欢下雨天"]'), ['主人喜欢下雨天']);
eq('空输入', parseFacts(''), []);
eq('null 输入', parseFacts(null), []);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
