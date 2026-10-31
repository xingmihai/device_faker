/**
 * Device Faker WebUI — 主逻辑
 *
 * 无框架的原生实现（替代原先的 Vue 3 + Element Plus + smol-toml + kernelsu-alt）。
 * 依赖：DfToml / DfKsu / DfPkg / DfI18n，均在 index.html 中按序引入。
 *
 * 结构约定：
 *   - 全局只维护一份 `state.config`（config.toml 的 JS 镜像），改完立即写回。
 *   - 每次渲染都是「重建 innerHTML + 事件委托」，控件数量在百级，开销可忽略，
 *     换来的是不用手写数据绑定。
 *   - 事件统一走 document 上的委托（data-act），避免重渲染后丢失监听。
 */
(function (global) {
  'use strict';

  const T = global.DfToml;
  const K = global.DfKsu;
  const P = global.DfPkg;
  const I = global.DfI18n;
  const t = I.t;

  const CONFIG_PATH = '/data/adb/device_faker/config/config.toml';
  const MODULE_PROP_PATH = '/data/adb/modules/device_faker/module.prop';
  const CONFIG_DIR = '/data/adb/device_faker/config';
  const BACKUP_KEY = 'device_faker_config_backup_v1';
  const THEME_KEY = 'device_faker_theme';

  /** 模板可编辑字段（与 src/config.rs 的 DeviceTemplate 对齐） */
  const BASIC_FIELDS = [
    ['manufacturer', '制造商'],
    ['brand', '品牌'],
    ['marketname', '营销名'],
    ['model', '型号'],
    ['name', '产品名'],
    ['device', '设备代号'],
    ['product', '产品代号'],
    ['hardware', '硬件'],
    ['board', '主板'],
    ['soc_model', 'SoC 型号'],
    ['fingerprint', '构建指纹'],
    ['build_id', '构建 ID'],
  ];

  const ADVANCED_FIELDS = [
    ['display_id', '系统版本号'],
    ['incremental', '增量号'],
    ['security_patch', '安全补丁'],
    ['characteristics', '特性'],
    ['android_version', 'Android 版本'],
    ['sdk_int', 'SDK 版本'],
    ['dpi', 'DPI'],
  ];

  const state = {
    config: {},
    moduleVersion: '',
    moduleAuthor: '',
    apps: [], // { name, label, isSystem }
    appInfo: new Map(),
    page: 'status',
    appFilter: 'user',
    appQuery: '',
    ready: false,
  };

  // ────────────────────────────────────────────────────────────
  // 工具
  // ────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg) {
    K.toast(msg);
    const host = document.getElementById('toast-host');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  const PAGES = [
    { id: 'status', icon: 'M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5' },
    { id: 'templates', icon: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },
    { id: 'apps', icon: 'M6 2h12v20H6zM11 18h2' },
    { id: 'settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.5-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z' },
  ];

  // ────────────────────────────────────────────────────────────
  // 配置读写
  // ────────────────────────────────────────────────────────────

  function backupSave(text) {
    try {
      localStorage.setItem(BACKUP_KEY, text);
    } catch (e) { /* 忽略 */ }
  }

  function backupLoad() {
    try {
      return localStorage.getItem(BACKUP_KEY);
    } catch (e) {
      return null;
    }
  }

  async function loadConfig() {
    let text = await K.readFile(CONFIG_PATH);
    if (!text) {
      const backup = backupLoad();
      if (backup) {
        text = backup;
        toast(t('useBackup'));
      }
    }
    if (!text) {
      await K.mkdir(CONFIG_DIR);
      state.config = {};
      await saveConfig();
      return;
    }
    try {
      state.config = T.parse(text);
      backupSave(text);
    } catch (e) {
      toast(t('loadFailed'));
      state.config = {};
    }
  }

  /**
   * 保存配置。
   *
   * 写完回读再解析一遍做校验——heredoc 写入在极端情况（内容含特殊字节）
   * 可能写歪，回读能立刻发现，而不是等下次打开才发现配置丢了。
   */
  async function saveConfig() {
    let text = T.stringify(state.config);
    if (!text.trim()) text = '# 空配置，全部使用模块默认值\n';
    await K.writeFile(CONFIG_PATH, text);
    const verify = await K.readFile(CONFIG_PATH);
    if (!verify) throw new Error(t('saveFailed'));
    T.parse(verify); // 回读解析校验
    backupSave(verify);
  }

  async function loadModuleMeta() {
    const text = await K.readFile(MODULE_PROP_PATH);
    const v = /version=(.+)/.exec(text);
    const a = /author=(.+)/.exec(text);
    state.moduleVersion = v ? v[1].trim() : '';
    state.moduleAuthor = a ? a[1].trim() : 'Seyud';
  }

  async function loadApps() {
    try {
      const pkgs = await K.listPackages(state.appFilter === 'system' ? 'system' : state.appFilter === 'all' ? 'all' : 'user');
      state.apps = (pkgs || []).map((name) => ({ name, label: name, isSystem: false }));
      state.appInfo = await K.getPackagesInfo(state.apps.map((a) => a.name).slice(0, 500));
    } catch (e) {
      state.apps = [];
    }
  }

  // ────────────────────────────────────────────────────────────
  // 模板 / 应用配置操作
  // ────────────────────────────────────────────────────────────

  function templates() {
    return state.config.templates || {};
  }

  function templateEntries() {
    return Object.entries(templates()).map(([name, template]) => ({ name, template }));
  }

  function apps() {
    return Array.isArray(state.config.apps) ? state.config.apps : [];
  }

  function ensureTemplates() {
    if (!state.config.templates || typeof state.config.templates !== 'object') state.config.templates = {};
  }

  function saveTemplate(name, tpl) {
    ensureTemplates();
    state.config.templates[name] = tpl;
  }

  function deleteTemplate(name) {
    ensureTemplates();
    delete state.config.templates[name];
  }

  /** 该实例当前生效的配置（用于应用页展示） */
  function resolveFor(appName) {
    return P.resolvePackageConfig(appName, apps(), templateEntries());
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：状态页
  // �───────────────────────────────────────────────────────────

  function renderStatus(el) {
    const entries = templateEntries();
    let pkgCount = entries.reduce((n, e) => n + (e.template.packages || []).length, 0);
    pkgCount += apps().length;

    el.innerHTML = `
      <div class="card card--accent">
        <div class="card-title">${esc(t('moduleStatus'))}</div>
        ${rowItem('◈', t('version'), state.moduleVersion || '—')}
        ${rowItem('✦', t('author'), state.moduleAuthor || '—')}
        ${rowItem('▣', t('templates'), String(entries.length))}
        ${rowItem('◉', '已配置条目', String(pkgCount))}
      </div>

      <div class="card">
        <div class="card-title">${esc(t('features'))}</div>
        ${rowItem('◆', 'COW 属性引擎', 'per-process 隔离 · 模块零驻留')}
        ${rowItem('◆', 'JNI 字段伪装', 'Build / Build.VERSION')}
        ${rowItem('◆', 'companion resetprop', '全局属性 · 前台门控')}
      </div>

      ${K.hasKsu() ? '' : `<div class="banner banner--info"><div><div class="banner-title">预览模式</div>${esc(t('notSupported'))}</div></div>`}
    `;
  }

  function rowItem(icon, title, sub) {
    return `
      <div class="row" style="cursor:default">
        <div class="row-icon">${esc(icon)}</div>
        <div class="row-body">
          <div class="row-title">${esc(title)}</div>
          <div class="row-sub">${esc(sub)}</div>
        </div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：模板页
  // ────────────────────────────────────────────────────────────

  function renderTemplates(el) {
    const entries = templateEntries();
    const conflicts = P.findConflictingPackages(entries);

    let html = '';

    if (conflicts.length) {
      html += `
        <div class="banner banner--warn">
          <div>
            <div class="banner-title">${esc(t('conflictTitle'))}</div>
            ${esc(t('conflictBody'))}
            ${conflicts
              .slice(0, 5)
              .map(
                (c) =>
                  `<div class="mono" style="margin-top:.35rem">${esc(c.packageName)} → ${esc(
                    c.templates.join(' / ')
                  )}</div>`
              )
              .join('')}
          </div>
        </div>`;
    }

    html += `<div class="card-actions" style="margin-bottom:.875rem">
      <button class="btn btn--primary btn--block" data-act="tpl-new">${esc(t('newTemplate'))}</button>
    </div>`;

    if (!entries.length) {
      html += `<div class="empty">${esc(t('emptyTemplates'))}</div>`;
    } else {
      html += entries
        .map(({ name, template: tpl }) => {
          const pkgs = tpl.packages || [];
          return `
          <div class="card">
            <div class="card-title">${esc(name)}</div>
            <div class="row-sub">${esc(tpl.model || tpl.device || '—')}</div>
            <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-top:.625rem">
              <span class="chip">${esc(pkgs.length)} ${esc(t('apps'))}</span>
              ${tpl.brand ? `<span class="chip">${esc(tpl.brand)}</span>` : ''}
              ${tpl.soc_model ? `<span class="chip">${esc(tpl.soc_model)}</span>` : ''}
            </div>
            <div class="card-actions">
              <button class="btn btn--sm" data-act="tpl-edit" data-name="${esc(name)}">${esc(t('edit'))}</button>
              <button class="btn btn--sm btn--danger" data-act="tpl-del" data-name="${esc(name)}">${esc(t('delete'))}</button>
            </div>
          </div>`;
        })
        .join('');
    }

    el.innerHTML = html;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：应用页
  // ────────────────────────────────────────────────────────────

  function renderApps(el) {
    const q = state.appQuery.trim().toLowerCase();
    const all = state.apps.slice().sort((a, b) => {
      const la = (state.appInfo.get(a.name) || {}).appLabel || a.name;
      const lb = (state.appInfo.get(b.name) || {}).appLabel || b.name;
      return la.localeCompare(lb);
    });
    const list = q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;

    let html = `
      <div class="field">
        <input class="input" id="app-search" placeholder="${esc(t('search'))}" value="${esc(state.appQuery)}" />
      </div>
      <div class="segmented" data-act="app-filter">
        <button data-v="user" class="${state.appFilter === 'user' ? 'active' : ''}">${esc(t('userApps'))}</button>
        <button data-v="system" class="${state.appFilter === 'system' ? 'active' : ''}">${esc(t('systemApps'))}</button>
        <button data-v="all" class="${state.appFilter === 'all' ? 'active' : ''}">${esc(t('allApps'))}</button>
      </div>
    `;

    if (!list.length) {
      html += `<div class="empty">${esc(t('emptyApps'))}</div>`;
    } else {
      html += list
        .map((a) => {
          const info = state.appInfo.get(a.name) || {};
          const label = info.appLabel || a.name;
          const res = resolveFor(a.name);
          const isSet = !!res;
          return `
          <div class="row" data-act="app-open" data-name="${esc(a.name)}">
            <div class="row-icon">${esc((label[0] || '?').toUpperCase())}</div>
            <div class="row-body">
              <div class="row-title">${esc(label)}</div>
              <div class="row-sub">${esc(a.name)}</div>
            </div>
            <div class="row-meta">
              ${
                isSet
                  ? `<span class="chip chip--ok">${esc(
                      res.kind === 'app' ? t('configured') : (res.name || res.templateName || t('template'))
                    )}</span>`
                  : `<span class="chip">${esc(t('noConfig'))}</span>`
              }
            </div>
          </div>`;
        })
        .join('');
    }

    el.innerHTML = html;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：设置页
  // ────────────────────────────────────────────────────────────

  function renderSettings(el) {
    const theme = getTheme();
    const lang = I.get();
    el.innerHTML = `
      <div class="card">
        <div class="card-title">${esc(t('theme'))}</div>
        <div class="segmented" data-act="set-theme">
          <button data-v="light" class="${theme === 'light' ? 'active' : ''}">${esc(t('themeLight'))}</button>
          <button data-v="dark" class="${theme === 'dark' ? 'active' : ''}">${esc(t('themeDark'))}</button>
          <button data-v="system" class="${theme === 'system' ? 'active' : ''}">${esc(t('themeSystem'))}</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${esc(t('language'))}</div>
        <div class="segmented" data-act="set-lang">
          ${I.list()
            .map(
              (l) =>
                `<button data-v="${l.code}" class="${lang === l.code ? 'active' : ''}">${esc(l.label)}</button>`
            )
            .join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-title">配置</div>
        <div class="card-actions">
          <button class="btn" data-act="cfg-export">${esc(t('exportCfg'))}</button>
          <button class="btn" data-act="cfg-import">${esc(t('importCfg'))}</button>
        </div>
        <div class="field-hint" style="margin-top:.625rem">配置路径 <span class="mono">${esc(CONFIG_PATH)}</span></div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染调度
  // ────────────────────────────────────────────────────────────

  function renderAll() {
    const map = {
      status: renderStatus,
      templates: renderTemplates,
      apps: renderApps,
      settings: renderSettings,
    };
    document.querySelectorAll('.page-panel').forEach((el) => {
      const fn = map[el.dataset.page];
      if (fn) fn(el);
    });
    renderNav();
  }

  function renderNav() {
    const nav = document.getElementById('bottom-nav');
    nav.innerHTML = PAGES.map(
      (p) => `
      <button class="nav-item ${state.page === p.id ? 'active' : ''}" data-act="nav" data-v="${p.id}">
        <span class="nav-icon">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round"><path d="${p.icon}"/></svg>
        </span>
        <span class="nav-label">${esc(t(p.id))}</span>
        <span class="nav-indicator"></span>
      </button>`
    ).join('');
  }

  function gotoPage(id) {
    state.page = id;
    const idx = PAGES.findIndex((p) => p.id === id);
    const track = document.getElementById('page-track');
    track.classList.add('dragging');
    track.style.transform = `translateX(${-idx * 100}%)`;
    setTimeout(() => track.classList.remove('dragging'), 340);
    renderNav();
    if (id === 'apps' && !state.apps.length) {
      loadApps().then(renderApps.bind(null, document.querySelector('[data-page="apps"]')));
    }
  }

  // ────────────────────────────────────────────────────────────
  // 弹层（Sheet）
  // ────────────────────────────────────────────────────────────

  function openSheet(title, bodyHtml, footHtml) {
    const host = document.getElementById('sheet-host');
    host.innerHTML = `
      <div class="sheet-backdrop" data-act="sheet-close">
        <div class="sheet" data-stop>
          <div class="sheet-head">
            <div class="sheet-title">${esc(title)}</div>
            <button class="btn btn--ghost btn--sm" data-act="sheet-close">✕</button>
          </div>
          <div class="sheet-body">${bodyHtml}</div>
          ${footHtml ? `<div class="sheet-foot">${footHtml}</div>` : ''}
        </div>
      </div>`;
  }

  function closeSheet() {
    document.getElementById('sheet-host').innerHTML = '';
  }

  /** 模板编辑弹层 */
  function openTemplateSheet(name) {
    const existing = name ? templates()[name] : null;
    const tpl = existing ? JSON.parse(JSON.stringify(existing)) : { packages: [] };

    const field = ([key, label], val) => `
      <div class="field">
        <label class="field-label">${esc(label)} <span class="mono" style="opacity:.6">${esc(key)}</span></label>
        <input class="input" data-tpl-field="${esc(key)}" value="${esc(val === undefined || val === null ? '' : val)}" />
      </div>`;

    const body = `
      <div class="field">
        <label class="field-label">${esc(t('templateName'))}</label>
        <input class="input" id="tpl-name" value="${esc(name || '')}" ${name ? 'readonly' : ''} />
      </div>
      <div class="field">
        <label class="field-label">${esc(t('appliedApps'))}</label>
        <textarea class="textarea mono" id="tpl-packages" placeholder="每行一个包名">${esc(
          (tpl.packages || []).join('\n')
        )}</textarea>
        <div class="field-hint">分身请在包名后加 <span class="mono">@userId</span>，例如 com.foo@999</div>
      </div>
      <div class="divider"></div>
      <div class="card-title" style="font-size:.9375rem">${esc(t('basic'))}</div>
      ${BASIC_FIELDS.map((f) => field(f, tpl[f[0]])).join('')}
      <div class="divider"></div>
      <div class="card-title" style="font-size:.9375rem">${esc(t('advanced'))}</div>
      ${ADVANCED_FIELDS.map((f) => field(f, tpl[f[0]])).join('')}
      <div class="divider"></div>
      <div class="switch-row">
        <div>
          <div style="font-size:.875rem;font-weight:500">companion resetprop</div>
          <div class="field-hint">全局属性写入（getprop 可见），默认关闭</div>
        </div>
        <button class="switch ${tpl.companion_resetprop ? 'on' : ''}" data-act="tpl-toggle" data-k="companion_resetprop"></button>
      </div>
      <div class="switch-row">
        <div>
          <div style="font-size:.875rem;font-weight:500">force denylist unmount</div>
          <div class="field-hint">强制解除 DenyList 挂载</div>
        </div>
        <button class="switch ${tpl.force_denylist_unmount ? 'on' : ''}" data-act="tpl-toggle" data-k="force_denylist_unmount"></button>
      </div>
    `;

    openSheet(
      name ? t('edit') + ' · ' + name : t('newTemplate'),
      body,
      `<button class="btn" data-act="sheet-close">${esc(t('cancel'))}</button>
       <button class="btn btn--primary" data-act="tpl-save" data-origin="${esc(name || '')}">${esc(t('save'))}</button>`
    );

    // 暂存当前编辑态（开关点击时读写）
    state.editing = tpl;
  }

  function collectTemplateFromSheet() {
    const tpl = state.editing || {};
    const name = document.getElementById('tpl-name').value.trim();
    const pkgs = document
      .getElementById('tpl-packages')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const out = {};
    if (pkgs.length) out.packages = pkgs;

    document.querySelectorAll('[data-tpl-field]').forEach((el) => {
      const key = el.dataset.tplField;
      const raw = el.value.trim();
      if (raw === '') return;
      // sdk_int / dpi 是数字，其余按字符串
      out[key] = key === 'sdk_int' || key === 'dpi' ? Number(raw) || 0 : raw;
    });

    if (tpl.companion_resetprop) out.companion_resetprop = true;
    if (tpl.force_denylist_unmount) out.force_denylist_unmount = true;

    return { name, tpl: out };
  }

  /** 应用配置弹层 */
  function openAppSheet(appName) {
    const res = resolveFor(appName);
    const entries = templateEntries();
    const currentTpl = res && res.kind === 'template' ? res.name : '';
    const ownApp = apps().find((a) => P.ownConfigKeys(appName).indexOf(a.package) !== -1);

    const scope = P.configKeyScope(appName);
    const scopeLabel = scope === 'clone' ? t('clone') : scope === 'user0' ? t('user0') : t('fallback');

    const body = `
      <div class="banner banner--info">
        <div>
          <div class="banner-title">${esc(P.packageDisplayName(appName))}</div>
          <div class="mono">${esc(appName)}</div>
          <div style="margin-top:.35rem">作用范围：<span class="chip ${scope === 'clone' ? 'chip--clone' : ''}">${esc(scopeLabel)}</span></div>
        </div>
      </div>

      <div class="field">
        <label class="field-label">${esc(t('template'))}</label>
        <select class="select" id="app-tpl">
          <option value="">${esc(t('noConfig'))}</option>
          ${entries
            .map(
              ({ name: n }) =>
                `<option value="${esc(n)}" ${n === currentTpl ? 'selected' : ''}>${esc(n)}</option>`
            )
            .join('')}
        </select>
        <div class="field-hint">选择模板后，本实例会被写入该模板的 packages 列表</div>
      </div>

      <div class="divider"></div>
      <div class="card-title" style="font-size:.9375rem">自定义字段（留空表示沿用模板）</div>
      ${BASIC_FIELDS.map(
        ([key, label]) => `
        <div class="field">
          <label class="field-label">${esc(label)} <span class="mono" style="opacity:.6">${esc(key)}</span></label>
          <input class="input" data-app-field="${esc(key)}"
                 value="${esc(ownApp && ownApp[key] !== undefined ? ownApp[key] : '')}" />
        </div>`
      ).join('')}
    `;

    openSheet(
      t('apps'),
      body,
      `<button class="btn" data-act="sheet-close">${esc(t('cancel'))}</button>
       <button class="btn btn--primary" data-act="app-save" data-name="${esc(appName)}">${esc(t('save'))}</button>`
    );
  }

  /** 保存应用配置：模板归属 + [[apps]] 自定义字段，键严格按 ownConfigKeys */
  async function saveAppConfig(appName) {
    const tplName = document.getElementById('app-tpl').value;
    const key = P.configWriteKey(appName);

    // ① 模板归属：先从所有模板里剔除本实例的键，再按需加入选中模板
    ensureTemplates();
    for (const [n, tpl] of Object.entries(state.config.templates)) {
      const pkgs = tpl.packages || [];
      const kept = P.filterOutOwnConfigKeys(pkgs, appName);
      if (n === tplName) {
        tpl.packages = kept.concat([key]);
      } else if (kept.length !== pkgs.length) {
        tpl.packages = kept;
      }
    }

    // ② [[apps]] 自定义字段
    if (!Array.isArray(state.config.apps)) state.config.apps = [];
    let app = state.config.apps.find((a) => a.package === key);

    const fields = {};
    document.querySelectorAll('[data-app-field]').forEach((el) => {
      const raw = el.value.trim();
      if (raw !== '') fields[el.dataset.appField] = raw;
    });

    if (Object.keys(fields).length) {
      if (!app) {
        app = { package: key };
        state.config.apps.push(app);
      }
      // 只覆盖本次填了的字段，未填的保持原值
      Object.assign(app, fields);
    } else if (app) {
      // 全空且无模板 → 整条删除
      if (!tplName) {
        state.config.apps = state.config.apps.filter((a) => a.package !== key);
      }
    }

    await saveConfig();
    toast(t('saved'));
    closeSheet();
    renderAll();
  }

  // ────────────────────────────────────────────────────────────
  // 主题
  // ────────────────────────────────────────────────────────────

  function getTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch (e) {
      return 'system';
    }
  }

  function setTheme(v) {
    try {
      localStorage.setItem(THEME_KEY, v);
    } catch (e) { /* 忽略 */ }
    applyTheme();
  }

  /** 系统是否偏好深色。matchMedia 在极老的 WebView 里可能不存在，做空值防护。 */
  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  function applyTheme() {
    const v = getTheme();
    const dark = v === 'dark' || (v === 'system' && systemPrefersDark());
    document.documentElement.classList.toggle('dark', dark);
  }

  // ────────────────────────────────────────────────────────────
  // 事件委托
  // ────────────────────────────────────────────────────────────

  function onClick(e) {
    // Sheet 内部点击不关闭
    const sheet = e.target.closest('[data-stop]');
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'sheet-close' && sheet) return; // 点内容区不关

    switch (act) {
      case 'nav':
        gotoPage(actEl.dataset.v);
        break;
      case 'sheet-close':
        closeSheet();
        break;
      case 'tpl-new':
        openTemplateSheet(null);
        break;
      case 'tpl-edit':
        openTemplateSheet(actEl.dataset.name);
        break;
      case 'tpl-del':
        confirmDelete(actEl.dataset.name);
        break;
      case 'tpl-toggle': {
        if (!state.editing) break;
        const k = actEl.dataset.k;
        state.editing[k] = !state.editing[k];
        actEl.classList.toggle('on', !!state.editing[k]);
        break;
      }
      case 'tpl-save':
        saveTemplateFromSheet(actEl.dataset.origin);
        break;
      case 'app-open':
        openAppSheet(actEl.dataset.name);
        break;
      case 'app-save':
        saveAppConfig(actEl.dataset.name);
        break;
      case 'set-theme':
        setTheme(actEl.dataset.v);
        renderSettings(document.querySelector('[data-page="settings"]'));
        break;
      case 'set-lang':
        I.set(actEl.dataset.v);
        renderAll();
        break;
      case 'app-filter':
        state.appFilter = actEl.dataset.v;
        loadApps().then(() => renderApps(document.querySelector('[data-page="apps"]')));
        break;
      case 'cfg-export':
        exportConfig();
        break;
      case 'cfg-import':
        importConfig();
        break;
    }
  }

  async function saveTemplateFromSheet(origin) {
    const { name, tpl } = collectTemplateFromSheet();
    if (!name) {
      toast(t('templateName') + ' ?');
      return;
    }
    if (origin && origin !== name) {
      deleteTemplate(origin);
    }
    saveTemplate(name, tpl);
    try {
      await saveConfig();
      toast(t('saved'));
    } catch (err) {
      toast(t('saveFailed') + ': ' + err.message);
    }
    closeSheet();
    renderAll();
  }

  function confirmDelete(name) {
    openSheet(
      t('deleteConfirmTitle'),
      `<div>${esc(t('deleteConfirmBody'))}</div><div class="mono" style="margin-top:.5rem">${esc(name)}</div>`,
      `<button class="btn" data-act="sheet-close">${esc(t('cancel'))}</button>
       <button class="btn btn--danger" data-act="tpl-del-yes" data-name="${esc(name)}">${esc(t('delete'))}</button>`
    );
  }

  document.addEventListener('click', async (e) => {
    // tpl-del-yes 在 sheet 内，需要单独处理
    const yes = e.target.closest('[data-act="tpl-del-yes"]');
    if (yes) {
      deleteTemplate(yes.dataset.name);
      try {
        await saveConfig();
        toast(t('saved'));
      } catch (err) {
        toast(t('saveFailed'));
      }
      closeSheet();
      renderAll();
      return;
    }
    onClick(e);
  });

  // 搜索框：输入防抖
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'app-search') return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.appQuery = e.target.value;
      renderApps(document.querySelector('[data-page="apps"]'));
      const again = document.getElementById('app-search');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 180);
  });

  // 左右滑动切页
  (function bindSwipe() {
    const track = document.getElementById('page-track');
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let dx = 0;

    track.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      dragging = true;
      dx = 0;
      track.classList.add('dragging');
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const touch = e.touches[0];
      dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // 纵向手势不抢（否则列表没法滚）
      if (Math.abs(dy) > Math.abs(dx)) {
        dragging = false;
        track.classList.remove('dragging');
        return;
      }
      const idx = PAGES.findIndex((p) => p.id === state.page);
      const w = track.clientWidth || 1;
      track.style.transform = `translateX(${-idx * 100 + (dx / w) * 100}%)`;
    }, { passive: true });

    track.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('dragging');
      const w = track.clientWidth || 1;
      const threshold = w * 0.22;
      const idx = PAGES.findIndex((p) => p.id === state.page);
      let next = idx;
      if (dx < -threshold) next = Math.min(PAGES.length - 1, idx + 1);
      else if (dx > threshold) next = Math.max(0, idx - 1);
      gotoPage(PAGES[next].id);
    });
  })();

  // ────────────────────────────────────────────────────────────
  // 导入 / 导出
  // ────────────────────────────────────────────────────────────

  function exportConfig() {
    const text = T.stringify(state.config);
    openSheet(
      t('exportCfg'),
      `<textarea class="textarea mono" style="min-height:14rem" readonly>${esc(text)}</textarea>`,
      `<button class="btn" data-act="sheet-close">${esc(t('cancel'))}</button>
       <button class="btn btn--primary" data-act="cfg-copy">${esc(t('copyOk'))}</button>`
    );
  }

  function importConfig() {
    openSheet(
      t('importCfg'),
      `<textarea class="textarea mono" id="cfg-in" style="min-height:14rem" placeholder="粘贴 TOML 配置"></textarea>`,
      `<button class="btn" data-act="sheet-close">${esc(t('cancel'))}</button>
       <button class="btn btn--primary" data-act="cfg-do-import">${esc(t('confirm'))}</button>`
    );
  }

  document.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-act="cfg-copy"]');
    if (copy) {
      const ta = document.querySelector('#sheet-host textarea');
      if (ta) {
        ta.select();
        try {
          await navigator.clipboard.writeText(ta.value);
        } catch (err) {
          document.execCommand('copy');
        }
        toast(t('copyOk'));
      }
      return;
    }
    const imp = e.target.closest('[data-act="cfg-do-import"]');
    if (imp) {
      const ta = document.getElementById('cfg-in');
      try {
        const parsed = T.parse(ta.value);
        state.config = parsed;
        await saveConfig();
        toast(t('saved'));
        closeSheet();
        renderAll();
      } catch (err) {
        toast(t('loadFailed') + ': ' + err.message);
      }
    }
  });

  // ────────────────────────────────────────────────────────────
  // 启动
  // ────────────────────────────────────────────────────────────

  async function boot() {
    applyTheme();
    try {
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
      }
    } catch (e) { /* 老 WebView 无 addEventListener，忽略 */ }

    renderAll();
    document.getElementById('hdr-sub').textContent = t('features');
    document.getElementById('hdr-version').textContent = '…';

    try {
      await Promise.all([loadConfig(), loadModuleMeta()]);
    } catch (e) {
      toast(t('loadFailed'));
    }

    document.getElementById('hdr-version').textContent = state.moduleVersion || '—';
    state.ready = true;
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
