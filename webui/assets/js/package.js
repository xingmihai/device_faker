/**
 * 包名 / 分身（多用户）键解析
 *
 * 这一层与 Rust 侧的查找顺序**必须严格一致**，否则界面显示的「是否已配置」
 * 会和运行时行为对不上。逻辑移植自 `webui/src/utils/package.ts` 与
 * `src/lib.rs` + `src/config.rs` 的 get_merged_config。
 *
 * 两套键语义是这里最容易搞混的地方：
 *   - runtimeConfigKeys：运行时**读取**顺序（含回退）
 *   - ownConfigKeys：本实例**拥有**的条目（编辑/删除只能碰这些）
 *
 * 分身改配置时若误写裸键，会连带改掉主应用和所有其他分身的配置
 * （历史 bug），因此 ownConfigKeys 对非零用户只返回 `pkg@uid`。
 */
(function (global) {
  'use strict';

  const SUFFIX_RE = /@\d+$/;

  /** "com.foo@999" -> { base: "com.foo", userId: 999 }；无后缀视为 user 0。 */
  function parsePackageUser(name) {
    const m = /^(.*)@(\d+)$/.exec(name);
    if (!m) return { base: name, userId: 0 };
    return { base: m[1], userId: Number(m[2]) };
  }

  function hasUserSuffix(name) {
    return SUFFIX_RE.test(name);
  }

  /**
   * 运行时查找顺序（镜像 src/lib.rs）：
   *   带后缀：pkg@uid -> 裸 pkg
   *   裸名  ：pkg@0   -> 裸 pkg（WebUI 列表把 user 0 枚举为裸包名）
   */
  function runtimeConfigKeys(name) {
    const { base } = parsePackageUser(name);
    return hasUserSuffix(name) ? [name, base] : [`${base}@0`, base];
  }

  /**
   * 本实例自有的配置键（写/删只应碰这些）：
   *   user 0 实例：pkg@0 + 裸 pkg
   *   分身 pkg@uid：只有 pkg@uid（裸键属于主应用，且是分身的回退键）
   */
  function ownConfigKeys(name) {
    const { base, userId } = parsePackageUser(name);
    if (!hasUserSuffix(name) || userId === 0) return [`${base}@0`, base];
    return [name];
  }

  function isOwnConfigKey(name, key) {
    return ownConfigKeys(name).indexOf(key) !== -1;
  }

  /** 实例身份键：user 0 的裸名与 `pkg@0` 属同一实例（用于 UI 去重）。 */
  function packageInstanceKey(name) {
    const { base, userId } = parsePackageUser(name);
    return `${base}@${userId}`;
  }

  /** 展示名：user 0 显示裸名，分身显示 `pkg@uid`。 */
  function packageDisplayName(name) {
    const { base, userId } = parsePackageUser(name);
    return userId === 0 ? base : `${base}@${userId}`;
  }

  /** 配置键的作用范围：user0（仅主应用）/ fallback（主应用+全部分身）/ clone（仅该分身）。 */
  function configKeyScope(key) {
    const m = /@(\d+)$/.exec(key);
    if (!m) return 'fallback';
    return Number(m[1]) === 0 ? 'user0' : 'clone';
  }

  /**
   * 写回配置时应使用的键。
   *
   * 优先复用已有命中键（避免裸名与 pkg@0 双写），但**继承来的回退键不算命中**：
   * 分身当前靠裸键回退命中时，必须写 `pkg@uid`，否则会改掉主应用的配置。
   */
  function configWriteKey(name, preferredKey) {
    const own = ownConfigKeys(name);
    if (preferredKey && own.indexOf(preferredKey) !== -1) return preferredKey;
    const { base, userId } = parsePackageUser(name);
    return hasUserSuffix(name) && userId !== 0 ? name : base;
  }

  function findOwnConfigKey(keys, name) {
    if (!keys || !keys.length) return null;
    for (const k of ownConfigKeys(name)) {
      if (keys.indexOf(k) !== -1) return k;
    }
    return null;
  }

  /** 把本实例的键从模板 packages 中剔除（其他实例/分身的键原样保留）。 */
  function filterOutOwnConfigKeys(keys, name) {
    const own = new Set(ownConfigKeys(name));
    return keys.filter((k) => !own.has(k));
  }

  /** 是否存在运行时会作用到该实例的项（仅用于「已配置」判定，不得用于写删）。 */
  function anyConfigApplies(configPackages, name) {
    const keys = runtimeConfigKeys(name);
    return configPackages.some((p) => keys.indexOf(p) !== -1);
  }

  /**
   * 逐键扫描、命中即停：返回**同一个键**上的 [[apps]] / 模板命中。
   *
   * 必须同键比较——运行时命中第一个键就返回，永不跨键混用。例：分身
   * `pkg@999` 在自己的键上被模板命中时，裸 base 上的 [[apps]] 条目对它不生效。
   */
  function resolvePackageMatches(name, apps, templateEntries) {
    for (const key of runtimeConfigKeys(name)) {
      const app = apps.find((a) => a.package === key);
      const entry = templateEntries.find((e) => (e.template.packages || []).indexOf(key) !== -1);
      if (!app && !entry) continue;
      const inherited = !isOwnConfigKey(name, key);
      return {
        key,
        inherited,
        appMatch: app ? { key, app, inherited } : null,
        templateMatch: entry ? { key, name: entry.name, template: entry.template, inherited } : null,
      };
    }
    return null;
  }

  /** 该实例的最终生效配置：键优先，同键内 [[apps]] 先于模板。 */
  function resolvePackageConfig(name, apps, templateEntries) {
    const m = resolvePackageMatches(name, apps, templateEntries);
    if (!m) return null;
    if (m.appMatch) return { kind: 'app', ...m.appMatch };
    if (m.templateMatch) return { kind: 'template', ...m.templateMatch };
    return null;
  }

  /** 找出被多个模板同时声明的包名（运行时只取书写最先者，其余静默丢弃）。 */
  function findConflictingPackages(entries) {
    const claimants = new Map();
    entries.forEach(({ name, template }) => {
      for (const pkg of template.packages || []) {
        const list = claimants.get(pkg);
        if (list) {
          if (list.indexOf(name) === -1) list.push(name); // 同模板内重复不算冲突
        } else {
          claimants.set(pkg, [name]);
        }
      }
    });
    return Array.from(claimants.entries())
      .filter(([, names]) => names.length > 1)
      .map(([packageName, templates]) => ({ packageName, templates }))
      .sort((a, b) => a.packageName.localeCompare(b.packageName));
  }

  global.DfPkg = {
    parsePackageUser,
    hasUserSuffix,
    runtimeConfigKeys,
    ownConfigKeys,
    isOwnConfigKey,
    packageInstanceKey,
    packageDisplayName,
    configKeyScope,
    configWriteKey,
    findOwnConfigKey,
    filterOutOwnConfigKeys,
    anyConfigApplies,
    resolvePackageMatches,
    resolvePackageConfig,
    findConflictingPackages,
  };
})(typeof window !== 'undefined' ? window : globalThis);
