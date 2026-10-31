/**
 * KernelSU WebUI 桥接层
 *
 * 原本依赖 npm 包 `kernelsu-alt`。去掉构建链后不能引入 npm 包，而该库本身
 * 只是对全局 `ksu` 对象的薄封装（exec / listPackages / getPackagesInfo /
 * toast），这里直接复刻其关键逻辑，零依赖。
 *
 * 参照 kernelsu-alt 3.3.0 的实现：
 *   - `ksu.exec(cmd, optionsJson, callbackName)`：结果经挂在 window 上的
 *     回调函数异步返回，回调名必须唯一，用完即删（否则 window 上会堆积）。
 *   - `ksu.listPackages(type)` / `ksu.getPackagesInfo(json)`：同步返回 JSON 串。
 *   - `ksu.toast(msg)`：原生 Toast。
 *
 * 非 WebUI 环境（本地浏览器直接打开预览）下 `ksu` 不存在，所有调用安全降级
 * 并给出明确错误，不会白屏——便于在没有真机时预览界面。
 */
(function (global) {
  'use strict';

  let cbCounter = 0;
  function uniqueName(prefix) {
    return `${prefix}_cb_${Date.now()}_${cbCounter++}`;
  }

  function hasKsu() {
    return typeof global.ksu !== 'undefined' && global.ksu !== null;
  }

  /** 执行 shell 命令。resolve({ errno, stdout, stderr })。 */
  function exec(command) {
    return new Promise((resolve, reject) => {
      if (!hasKsu()) {
        reject(new Error('ksu 不可用（非 KernelSU WebUI 环境）'));
        return;
      }
      const name = uniqueName('exec');
      let settled = false;
      global[name] = (errno, stdout, stderr) => {
        settled = true;
        delete global[name];
        resolve({ errno: errno | 0, stdout: stdout || '', stderr: stderr || '' });
      };
      try {
        global.ksu.exec(command, '{}', name);
      } catch (e) {
        if (!settled) delete global[name];
        reject(e);
      }
    });
  }

  /** 执行命令并断言成功；失败抛出带 stderr 的错误。 */
  async function execOrThrow(command) {
    const r = await exec(command);
    if (r.errno !== 0) {
      throw new Error(`${command} 失败(${r.errno}): ${r.stderr || r.stdout || '无输出'}`);
    }
    return r.stdout || '';
  }

  function toast(msg) {
    if (hasKsu() && typeof global.ksu.toast === 'function') global.ksu.toast(msg);
    else console.log('[toast]', msg);
  }

  /** 读取文件内容（trim 后）。文件不存在时返回空串。 */
  async function readFile(path) {
    try {
      const out = await execOrThrow(`cat ${q(path)}`);
      return out.trim();
    } catch (e) {
      return '';
    }
  }

  async function fileExists(path) {
    try {
      await execOrThrow(`test -f ${q(path)}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function mkdir(path) {
    try {
      await execOrThrow(`mkdir -p ${q(path)}`);
    } catch (e) {
      /* 已存在或权限不足时忽略，由后续写入暴露真实错误 */
    }
  }

  /**
   * 写入文件（原子替换）。
   *
   * 用 heredoc 写临时文件 → sync → mv -f，避免写到一半断电留下半个文件；
   * 分隔符动态避让内容中的冲突行（内容里若正好有 `EOF_DEVICE_FAKER` 会截断）。
   */
  async function writeFile(path, content) {
    const delim = pickDelimiter(content);
    const tmp = `${path}.tmp.${Date.now()}`;
    const script = [
      `cat << '${delim}' > ${q(tmp)}`,
      content,
      delim,
      `sync ${q(tmp)} || true`,
      `mv -f ${q(tmp)} ${q(path)}`,
    ].join('\n');
    try {
      await execOrThrow(script);
    } catch (e) {
      await execOrThrow(`rm -f ${q(tmp)}`).catch(() => {});
      throw e;
    }
  }

  function pickDelimiter(content) {
    const base = 'EOF_DEVICE_FAKER';
    const norm = content.replace(/\r\n/g, '\n');
    const clash = (d) =>
      norm.includes(`\n${d}\n`) || norm.startsWith(`${d}\n`) || norm.endsWith(`\n${d}`);
    if (!clash(base)) return base;
    let n = 0;
    for (;;) {
      n += 1;
      const d = `${base}_${n}_${Math.random().toString(36).slice(2, 8)}`;
      if (!clash(d)) return d;
    }
  }

  /** shell 单引号转义：`'` → `'\''` */
  function q(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
  }

  /** 列出已安装包名。优先用 ksu 原生接口，失败则用 pm 命令兜底。 */
  async function listPackages(type) {
    if (hasKsu() && typeof global.ksu.listPackages === 'function') {
      try {
        const raw = global.ksu.listPackages(type || 'user');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (e) {
        /* 落到 pm 兜底 */
      }
    }
    const flag = type === 'system' ? '-s' : type === 'all' ? '' : '-3';
    const out = await execOrThrow(`pm list packages ${flag}`.trim());
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^package:/, ''));
  }

  /**
   * 批量取包信息（应用名 / 是否系统应用）。
   * 返回 Map<packageName, { appLabel, isSystem }>。
   */
  async function getPackagesInfo(pkgs) {
    const map = new Map();
    if (!pkgs.length) return map;
    if (!hasKsu() || typeof global.ksu.getPackagesInfo !== 'function') return map;
    try {
      const raw = global.ksu.getPackagesInfo(JSON.stringify(pkgs));
      const arr = JSON.parse(raw);
      for (const item of Array.isArray(arr) ? arr : [arr]) {
        if (item && item.packageName) map.set(item.packageName, item);
      }
    } catch (e) {
      /* 拿不到信息不影响主流程，UI 会退化显示包名 */
    }
    return map;
  }

  global.DfKsu = {
    hasKsu,
    exec,
    execOrThrow,
    toast,
    readFile,
    writeFile,
    fileExists,
    mkdir,
    listPackages,
    getPackagesInfo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
