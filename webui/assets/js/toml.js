/**
 * TOML 解析 / 序列化（够用子集）
 *
 * 为什么自己写：本项目原本依赖 `smol-toml`（npm）。去掉构建链后不能再引入
 * npm 包，而 config.toml 的结构是固定的、有限的，自己实现比塞一个通用库
 * 更可控、体积也小得多。
 *
 * 支持的语法（覆盖 config.toml 实际用到的全部形态）：
 *   - 注释（`#` 起至行尾；字符串内的 `#` 不算）
 *   - 顶层 `key = value`
 *   - `[table]` / `[table.sub]` / `[[array-of-tables]]`
 *   - 带引号的表名：`[templates."一加15"]`（中文模板名必须）
 *   - 值：基本字符串 `"..."`、字面字符串 `'...'`、多行 `"""..."""`、
 *         整数、布尔、数组（单行与跨行，可尾逗号）
 *
 * 值的运行时表示统一为 JS 原生类型：string / number / boolean / Array / Object。
 * 解析结果保留书写顺序（用 Map），序列化时按该顺序回写，避免字段乱序造成的
 * 无意义 diff —— 模板顺序在运行时是有语义的（冲突时取书写最先者）。
 */
(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 词法层：把一行切成「注释外的有效内容」
  // ────────────────────────────────────────────────────────────

  /** 去掉行尾注释（不破坏字符串内部的 `#`）。返回裁剪后的字符串。 */
  function stripComment(line) {
    let quote = null; // 当前所处的引号：'"' | "'" | '"""'
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      if (quote === '"""') {
        if (line.startsWith('"""', i)) return line.slice(0, i + 3); // 多行串内不找注释
        i += 1;
        continue;
      }

      if (quote) {
        if (ch === '\\' && quote === '"') i += 2;
        else if (ch === quote) quote = null;
        else i += 1;
        continue;
      }

      if (line.startsWith('"""', i)) {
        quote = '"""';
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '#') return line.slice(0, i);
      i += 1;
    }
    return line;
  }

  /** 解析键名：标识符、或带引号的字符串。返回 { key, rest }。 */
  function parseKeyName(str) {
    str = str.trim();
    if (str[0] === '"' || str[0] === "'") {
      const q = str[0];
      let i = 1;
      let out = '';
      while (i < str.length && str[i] !== q) {
        if (q === '"' && str[i] === '\\') {
          out += unescapeChar(str[i + 1]);
          i += 2;
        } else {
          out += str[i];
          i += 1;
        }
      }
      return { key: out, rest: str.slice(i + 1) };
    }
    const m = /^[A-Za-z0-9_-]+/.exec(str);
    if (!m) throw new Error(`无法解析键名: ${str.slice(0, 20)}`);
    return { key: m[0], rest: str.slice(m[0].length) };
  }

  function unescapeChar(c) {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return c;
    }
  }

  /** 解析一个值。可能跨行（多行数组/多行字符串），故传入全文与游标。 */
  function parseValue(text, start) {
    let i = start;
    while (i < text.length && /\s/.test(text[i]) && text[i] !== '\n') i += 1;
    const ch = text[i];

    // 多行基本字符串 """..."""
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end === -1) throw new Error('未闭合的多行字符串');
      let body = text.slice(i + 3, end);
      // 紧跟开头引号的换行被吃掉（TOML 规范）
      if (body.startsWith('\r\n')) body = body.slice(2);
      else if (body.startsWith('\n')) body = body.slice(1);
      return { value: body, next: end + 3 };
    }

    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          out += unescapeChar(text[j + 1]);
          j += 2;
        } else {
          out += text[j];
          j += 1;
        }
      }
      return { value: out, next: j + 1 };
    }

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error('未闭合的字面字符串');
      return { value: text.slice(i + 1, end), next: end + 1 };
    }

    if (ch === '[') {
      return parseArray(text, i);
    }

    // 其余：读到行尾或逗号，再判定标量类型
    let end = i;
    while (end < text.length && text[end] !== '\n' && text[end] !== ',') end += 1;
    const raw = text.slice(i, end).trim();
    return { value: parseScalar(raw), next: end };
  }

  /** 数组：允许跨行、允许尾逗号、元素可以是任意标量。 */
  function parseArray(text, start) {
    let i = start + 1;
    const arr = [];
    for (;;) {
      // 跳过空白与注释（跨行数组里可能有注释行）
      for (;;) {
        while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1;
        if (i < text.length && text[i] === '#') {
          while (i < text.length && text[i] !== '\n') i += 1;
          continue;
        }
        break;
      }
      if (i >= text.length) throw new Error('未闭合的数组');
      if (text[i] === ']') return { value: arr, next: i + 1 };

      const r = parseValue(text, i);
      arr.push(r.value);
      i = r.next;

      // 跳到下一个逗号或闭合
      for (;;) {
        while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1;
        if (i < text.length && text[i] === '#') {
          while (i < text.length && text[i] !== '\n') i += 1;
          continue;
        }
        break;
      }
      if (i >= text.length) throw new Error('未闭合的数组');
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') return { value: arr, next: i + 1 };
      throw new Error(`数组解析异常，位置 ${i}: ${text.slice(i, i + 20)}`);
    }
  }

  function parseScalar(raw) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === '') return '';
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
    // 兜底当字符串（本项目配置里不会出现裸字符串，但容错更稳）
    return raw;
  }

  // ────────────────────────────────────────────────────────────
  // 解析入口
  // ────────────────────────────────────────────────────────────

  /**
   * 解析 TOML 文本。
   *
   * @param {string} text
   * @returns {Object} 普通对象（表也是对象；数组表是数组）
   */
  function parse(text) {
    // 统一换行，避免 Windows 行尾影响跨行结构解析
    const src = text.replace(/\r\n/g, '\n');
    const lines = src.split('\n');

    /** @type {any} 根容器 */
    const root = {};
    /** 当前写入目标 */
    let current = root;
    /** 当前所处的完整键路径（用于 diagnostics，保留便于排障） */
    let path = [];

    let i = 0;
    while (i < lines.length) {
      const line = stripComment(lines[i]).trim();

      if (line === '') {
        i += 1;
        continue;
      }

      // 表头 / 数组表头：必须以 '[' 开头且不是数组值
      if (line[0] === '[') {
        const isArrayTable = line[1] === '[';
        const openLen = isArrayTable ? 2 : 1;
        const closeLen = isArrayTable ? 2 : 1;
        const inner = line.slice(openLen, line.length - closeLen).trim();

        const keys = parseDottedKey(inner);
        current = resolveTable(root, keys, isArrayTable);
        path = keys;
        i += 1;
        continue;
      }

      // key = value
      const eq = line.indexOf('=');
      if (eq === -1) {
        i += 1; // 无法识别的行，跳过（容错）
        continue;
      }
      const keyPart = line.slice(0, eq);
      const { key } = parseKeyName(keyPart);

      // 值可能跨行（多行数组 / 多行字符串），需用全文继续解析
      // 计算 `=` 在全文中的绝对偏移
      let abs = 0;
      for (let k = 0; k < i; k += 1) abs += lines[k].length + 1;
      const absEq = abs + line.indexOf('=');

      let r;
      try {
        r = parseValue(src, absEq + 1);
      } catch (e) {
        throw new Error(`解析键 "${key}" 的值失败: ${e.message}`);
      }
      current[key] = r.value;

      // 跳过被值消耗掉的行（多行数组/字符串会吃掉后续若干行）
      const consumed = src.slice(absEq, r.next).split('\n').length - 1;
      i += Math.max(1, consumed);
    }

    return root;
  }

  /** 解析 `a.b."c d"` 这类点分键。 */
  function parseDottedKey(str) {
    const keys = [];
    let s = str.trim();
    while (s.length) {
      const r = parseKeyName(s);
      keys.push(r.key);
      s = r.rest.trim();
      if (s[0] === '.') s = s.slice(1).trim();
      else break;
    }
    return keys;
  }

  /** 按路径创建/定位表；isArrayTable 表示末级是数组表（追加一项）。 */
  function resolveTable(root, keys, isArrayTable) {
    let node = root;
    for (let k = 0; k < keys.length - 1; k += 1) {
      const key = keys[k];
      if (!(key in node) || node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) {
        node[key] = {};
      }
      node = node[key];
    }
    const last = keys[keys.length - 1];
    if (isArrayTable) {
      if (!Array.isArray(node[last])) node[last] = [];
      if (last === 'apps' || !node[last].length) {
        // 标准语义：每个 [[x]] 头都追加一个新元素
      }
      const fresh = {};
      node[last].push(fresh);
      return fresh;
    }
    if (!(last in node) || node[last] === null || typeof node[last] !== 'object' || Array.isArray(node[last])) {
      // 注意：重复写同一个 [table] 头在严格 TOML 里是错误，这里容错为「继续写入已有表」，
      // 因为 module/config.toml 里存在 `[templates]` 后跟 `[templates.xxx]` 的写法。
      node[last] = {};
    }
    return node[last];
  }

  // ────────────────────────────────────────────────────────────
  // 序列化
  // ────────────────────────────────────────────────────────────

  /** 键名是否需要加引号（含中文、空格、点时统一加，保证回读一致）。 */
  function quoteKey(key) {
    if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
    return `"${escapeString(key)}"`;
  }

  function escapeString(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  function formatValue(v) {
    if (v === null || v === undefined) return '""';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      // 短数组单行，长数组每行一个（贴近原配置的手写风格）
      const items = v.map((x) => (typeof x === 'string' ? `"${escapeString(x)}"` : formatScalar(x)));
      const single = `[${items.join(', ')}]`;
      if (single.length <= 72) return single;
      return `[\n${items.map((x) => `    ${x}`).join(',\n')},\n]`;
    }
    if (typeof v === 'object') {
      // 内联表（本项目不会生成，但保证可逆）
      const parts = Object.entries(v).map(([k, val]) => `${quoteKey(k)} = ${formatValue(val)}`);
      return `{ ${parts.join(', ')} }`;
    }
    return `"${escapeString(v)}"`;
  }

  function formatScalar(v) {
    if (typeof v === 'string') return `"${escapeString(v)}"`;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    return '""';
  }

  /**
   * 序列化为 TOML 文本。
   *
   * 输出顺序：顶层标量 → [templates.*] → [[apps]]。
   * 其余顶层表按原顺序输出，保证「读进来再写回去」字段不会乱跑。
   */
  function stringify(obj) {
    const out = [];

    /**
     * 递归展开一个表为若干 `[dotted.key]` 段。
     *
     * 用表头形式而不是内联表：内联表在 TOML 里不能跨行、也不能再包含子表，
     * 一旦嵌套两层就会写不出合法语法（实测 `[a.b.c]` 会被写成
     * `b = { c = { ... } }`，回读虽然等价但可读性差、且偏离手写风格）。
     */
    function emitTable(table, prefix) {
      // 先输出本层的标量 / 数组
      const scalars = [];
      const nested = [];
      for (const [k, v] of Object.entries(table)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) nested.push([k, v]);
        else scalars.push([k, v]);
      }

      // 只有嵌套内容时也要写表头，否则子表路径会丢
      if (scalars.length || !nested.length) {
        if (prefix) out.push(`[${prefix}]`);
        for (const [k, v] of scalars) out.push(`${quoteKey(k)} = ${formatValue(v)}`);
        if (scalars.length) out.push('');
      }

      for (const [k, v] of nested) {
        emitTable(v, prefix ? `${prefix}.${quoteKey(k)}` : quoteKey(k));
      }
    }

    // 1) 顶层标量 / 数组（数组也是「值」，必须在这里输出，不能落进表逻辑）
    const topNested = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'apps') continue; // apps 是数组表，单独处理
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        topNested.push([k, v]);
        continue;
      }
      out.push(`${quoteKey(k)} = ${formatValue(v)}`);
    }
    if (out.length) out.push('');

    // 2) 顶层表（含 templates），递归展开
    for (const [k, v] of topNested) emitTable(v, quoteKey(k));

    // 3) apps（数组表）
    if (Array.isArray(obj.apps)) {
      for (const app of obj.apps) {
        out.push('[[apps]]');
        // package 优先输出，读起来更像手写配置
        const keys = Object.keys(app).sort((a, b) => (a === 'package' ? -1 : b === 'package' ? 1 : 0));
        for (const k of keys) out.push(`${quoteKey(k)} = ${formatValue(app[k])}`);
        out.push('');
      }
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  global.DfToml = { parse, stringify, quoteKey, formatValue };
})(typeof window !== 'undefined' ? window : globalThis);
