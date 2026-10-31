/**
 * 国际化（简体中文 / English / Türkçe）
 *
 * 语言选择存 localStorage。缺省按系统语言猜测，猜不出用中文。
 */
(function (global) {
  'use strict';

  const STORE_KEY = 'device_faker_lang';

  const dict = {
    'zh-CN': {
      status: '状态', templates: '模板', apps: '应用', settings: '设置',
      moduleStatus: '模块状态', version: '版本', author: '作者',
      features: '功能特性', loading: '加载中…', save: '保存', cancel: '取消',
      delete: '删除', edit: '编辑', add: '新建', confirm: '确定', search: '搜索',
      appName: '应用名', packageName: '包名', template: '模板', noConfig: '未配置',
      configured: '已配置', inherited: '继承', clone: '分身', user0: '主用户',
      fallback: '全部用户', newTemplate: '新建模板', templateName: '模板名',
      appliedApps: '应用到的包名', fieldSettings: '字段设置', basic: '基础',
      advanced: '高级', allApps: '全部应用', userApps: '用户应用',
      systemApps: '系统应用', theme: '主题', language: '语言',
      themeLight: '浅色', themeDark: '深色', themeSystem: '跟随系统',
      exportCfg: '导出配置', importCfg: '导入配置',
      saved: '已保存', loadFailed: '加载配置失败', saveFailed: '保存失败',
      useBackup: '已使用本地备份', deleteConfirmTitle: '确认删除',
      deleteConfirmBody: '删除后不可恢复，确定继续？',
      conflictTitle: '包名配置冲突',
      conflictBody: '同一包名被多个模板声明时，运行时只生效书写最先的那个模板。',
      notSupported: '当前不在 KernelSU WebUI 环境中，部分功能不可用。',
      emptyTemplates: '还没有模板，点“新建”添加一个。',
      emptyApps: '没有匹配的应用。',
      copyOk: '已复制到剪贴板',
    },
    en: {
      status: 'Status', templates: 'Templates', apps: 'Apps', settings: 'Settings',
      moduleStatus: 'Module Status', version: 'Version', author: 'Author',
      features: 'Features', loading: 'Loading…', save: 'Save', cancel: 'Cancel',
      delete: 'Delete', edit: 'Edit', add: 'New', confirm: 'OK', search: 'Search',
      appName: 'App', packageName: 'Package', template: 'Template', noConfig: 'Unset',
      configured: 'Configured', inherited: 'Inherited', clone: 'Clone', user0: 'Owner',
      fallback: 'All users', newTemplate: 'New Template', templateName: 'Template name',
      appliedApps: 'Applied packages', fieldSettings: 'Fields', basic: 'Basic',
      advanced: 'Advanced', allApps: 'All', userApps: 'User',
      systemApps: 'System', theme: 'Theme', language: 'Language',
      themeLight: 'Light', themeDark: 'Dark', themeSystem: 'System',
      exportCfg: 'Export', importCfg: 'Import',
      saved: 'Saved', loadFailed: 'Failed to load config', saveFailed: 'Failed to save',
      useBackup: 'Local backup restored', deleteConfirmTitle: 'Confirm delete',
      deleteConfirmBody: 'This cannot be undone. Continue?',
      conflictTitle: 'Package conflict',
      conflictBody: 'When several templates claim one package, only the first takes effect.',
      notSupported: 'Not inside KernelSU WebUI, some features are unavailable.',
      emptyTemplates: 'No templates yet. Tap “New” to add one.',
      emptyApps: 'No matching apps.',
      copyOk: 'Copied',
    },
    tr: {
      status: 'Durum', templates: 'Şablonlar', apps: 'Uygulamalar', settings: 'Ayarlar',
      moduleStatus: 'Modül Durumu', version: 'Sürüm', author: 'Yazar',
      features: 'Özellikler', loading: 'Yükleniyor…', save: 'Kaydet', cancel: 'İptal',
      delete: 'Sil', edit: 'Düzenle', add: 'Yeni', confirm: 'Tamam', search: 'Ara',
      appName: 'Uygulama', packageName: 'Paket', template: 'Şablon', noConfig: 'Ayarlı değil',
      configured: 'Ayarlı', inherited: 'Miras', clone: 'Klon', user0: 'Ana kullanıcı',
      fallback: 'Tüm kullanıcılar', newTemplate: 'Yeni Şablon', templateName: 'Şablon adı',
      appliedApps: 'Uygulanan paketler', fieldSettings: 'Alanlar', basic: 'Temel',
      advanced: 'Gelişmiş', allApps: 'Tümü', userApps: 'Kullanıcı',
      systemApps: 'Sistem', theme: 'Tema', language: 'Dil',
      themeLight: 'Açık', themeDark: 'Koyu', themeSystem: 'Sistem',
      exportCfg: 'Dışa aktar', importCfg: 'İçe aktar',
      saved: 'Kaydedildi', loadFailed: 'Yapılandırma yüklenemedi', saveFailed: 'Kaydedilemedi',
      useBackup: 'Yerel yedek geri yüklendi', deleteConfirmTitle: 'Silmeyi onayla',
      deleteConfirmBody: 'Bu işlem geri alınamaz. Devam edilsin mi?',
      conflictTitle: 'Paket çakışması',
      conflictBody: 'Bir paket birden fazla şablonda varsa yalnızca ilki geçerli olur.',
      notSupported: 'KernelSU WebUI içinde değil, bazı özellikler kullanılamaz.',
      emptyTemplates: 'Henüz şablon yok. “Yeni” ile ekleyin.',
      emptyApps: 'Eşleşen uygulama yok.',
      copyOk: 'Kopyalandı',
    },
  };

  let current = 'zh-CN';

  function detect() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && dict[saved]) return saved;
    } catch (e) { /* localStorage 不可用时忽略 */ }
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('tr')) return 'tr';
    if (nav.startsWith('zh')) return 'zh-CN';
    return 'en';
  }

  function set(lang) {
    if (!dict[lang]) return;
    current = lang;
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch (e) { /* 忽略 */ }
    document.documentElement.lang = lang;
  }

  function get() {
    return current;
  }

  /** 取文案；缺失时回退中文，再缺失则直接返回 key，避免界面出现 undefined。 */
  function t(key) {
    const table = dict[current] || dict['zh-CN'];
    return table[key] || dict['zh-CN'][key] || key;
  }

  function list() {
    return [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'en', label: 'English' },
      { code: 'tr', label: 'Türkçe' },
    ];
  }

  set(detect());

  global.DfI18n = { t, set, get, list };
})(typeof window !== 'undefined' ? window : globalThis);
