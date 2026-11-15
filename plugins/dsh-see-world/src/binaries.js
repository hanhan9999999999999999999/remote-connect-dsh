/**
 * binaries.js — 找到 ffmpeg。
 *
 * 为什么要专门找：DSH 桌面版把 ffmpeg 放在 `$DSH_HOME/tools/ffmpeg/bin/`，**不进 PATH**；
 * 而 plugin 进程继承的环境里 PATH 也不保证有它。写裸 `ffmpeg` 在这里就是 ENOENT，
 * 而 ENOENT 会被用户读成「插件坏了」。
 *
 * 优先级（从最确定到最兜底）：
 *   1. `$DSH_HOME/see-world.json` 里的 `ffmpegPath`（用户/安装脚本写进去的）
 *   2. DSH_SEE_WORLD_FFMPEG / DSH_FFMPEG_PATH / FFMPEG_PATH
 *   3. DSH_FFMPEG_DIR + ffmpeg(.exe)
 *   4. $DSH_HOME/tools/ffmpeg/bin/ffmpeg(.exe)
 *   5. $DSH_HOME/bin/ffmpeg(.exe)
 *   6. 裸 `ffmpeg`，交给 PATH
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exe = (platform) => (platform === 'win32' ? '.exe' : '');

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

/** 读 `$DSH_HOME/see-world.json`（读不到返回 {}）。 */
export function readSettingsFile(env = process.env) {
  try {
    const p = join(dshHome(env), 'see-world.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform, settings?:object}} [opts]
 * @returns {{path:string, source:string}}
 */
export function resolveFfmpeg({ env = process.env, platform = process.platform, settings = null } = {}) {
  const name = `ffmpeg${exe(platform)}`;
  const cfg = settings ?? readSettingsFile(env);

  if (cfg.ffmpegPath) return { path: String(cfg.ffmpegPath), source: 'settings' };

  const explicit = env.DSH_SEE_WORLD_FFMPEG || env.DSH_FFMPEG_PATH || env.FFMPEG_PATH || '';
  if (explicit) return { path: explicit, source: 'env' };

  const dir = env.DSH_FFMPEG_DIR;
  if (dir) return { path: join(dir, name), source: 'DSH_FFMPEG_DIR' };

  const home = dshHome(env);
  for (const p of [join(home, 'tools', 'ffmpeg', 'bin', name), join(home, 'bin', name)]) {
    if (existsSync(p)) return { path: p, source: p };
  }
  return { path: name, source: 'PATH' };
}

/** 给「找不到 ffmpeg」用的可执行建议（写进工具返回，模型会原样告诉用户）。 */
export function ffmpegHint(env = process.env, platform = process.platform) {
  const name = `ffmpeg${exe(platform)}`;
  const dir = join(dshHome(env), 'tools', 'ffmpeg', 'bin');
  return `没找到 ffmpeg。最省事的办法：把 ${name} 放到 ${join(dir, name)}，`
    + `或者在 ${join(dshHome(env), 'see-world.json')} 里写 {"ffmpegPath": "…\\\\ffmpeg.exe"}。`
    + '（Windows 上从 gyan.dev 下 essentials 版解压即可。）';
}
