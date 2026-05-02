const TRANSLATIONS = {
  en: {
    'settings.section.terminal': 'Terminal',
    'settings.font': 'Font',
    'settings.fontSize': 'Font size',
    'settings.section.panes': 'Panes',
    'settings.paneWidth': 'Width',
    'settings.paneOpacity': 'Opacity',
    'settings.inactiveTint': 'Inactive tint',
    'settings.activityIndicator': 'Activity indicator',
    'settings.section.configuration': 'Configuration',
    'settings.language': 'Language',
    'settings.shellProfiles': 'Shell Profiles',
    'settings.keyboardShortcuts': 'Keyboard Shortcuts',
    'settings.installShellIntegration': 'Install Shell Integration',
    'menu.changeColor': 'Change Color…',
    'menu.backgroundActivityAlert': 'Background activity alert',
    'menu.selectAll': 'Select All',
    'menu.changeProfile': 'Change Profile',
    'menu.pasteImage': 'Paste Image',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.renameTab': 'Rename Tab',
    'menu.closeTab': 'Close Tab',
    'msg.shellIntegrationInstalled': 'Shell integration installed. Source line copied — paste into your ~/.zshrc or ~/.bashrc',
    'msg.shellIntegrationFailed': 'Shell integration install failed: ',
  },
  'zh-CN': {
    'settings.section.terminal': '终端',
    'settings.font': '字体',
    'settings.fontSize': '字体大小',
    'settings.section.panes': '面板',
    'settings.paneWidth': '宽度',
    'settings.paneOpacity': '透明度',
    'settings.inactiveTint': '非活跃遮罩',
    'settings.activityIndicator': '活动指示器',
    'settings.section.configuration': '配置',
    'settings.language': '语言',
    'settings.shellProfiles': 'Shell 配置',
    'settings.keyboardShortcuts': '键盘快捷键',
    'settings.installShellIntegration': '安装 Shell 集成',
    'menu.changeColor': '更改颜色…',
    'menu.backgroundActivityAlert': '后台活动提示',
    'menu.selectAll': '全选',
    'menu.changeProfile': '切换配置',
    'menu.pasteImage': '粘贴图片',
    'menu.copy': '复制',
    'menu.paste': '粘贴',
    'menu.renameTab': '重命名标签',
    'menu.closeTab': '关闭标签',
    'msg.shellIntegrationInstalled': 'Shell 集成已安装，源码行已复制 — 粘贴至 ~/.zshrc 或 ~/.bashrc',
    'msg.shellIntegrationFailed': 'Shell 集成安装失败：',
  },
  'zh-TW': {
    'settings.section.terminal': '終端機',
    'settings.font': '字體',
    'settings.fontSize': '字體大小',
    'settings.section.panes': '面板',
    'settings.paneWidth': '寬度',
    'settings.paneOpacity': '透明度',
    'settings.inactiveTint': '非活躍遮罩',
    'settings.activityIndicator': '活動指示器',
    'settings.section.configuration': '設定',
    'settings.language': '語言',
    'settings.shellProfiles': 'Shell 設定檔',
    'settings.keyboardShortcuts': '鍵盤快捷鍵',
    'settings.installShellIntegration': '安裝 Shell 整合',
    'menu.changeColor': '更改顏色…',
    'menu.backgroundActivityAlert': '背景活動提示',
    'menu.selectAll': '全選',
    'menu.changeProfile': '切換設定檔',
    'menu.pasteImage': '貼上圖片',
    'menu.copy': '複製',
    'menu.paste': '貼上',
    'menu.renameTab': '重新命名標籤',
    'menu.closeTab': '關閉標籤',
    'msg.shellIntegrationInstalled': 'Shell 整合已安裝，源碼行已複製 — 貼至 ~/.zshrc 或 ~/.bashrc',
    'msg.shellIntegrationFailed': 'Shell 整合安裝失敗：',
  },
  ja: {
    'settings.section.terminal': 'ターミナル',
    'settings.font': 'フォント',
    'settings.fontSize': 'フォントサイズ',
    'settings.section.panes': 'ペイン',
    'settings.paneWidth': '幅',
    'settings.paneOpacity': '透明度',
    'settings.inactiveTint': '非アクティブマスク',
    'settings.activityIndicator': 'アクティビティ表示',
    'settings.section.configuration': '設定',
    'settings.language': '言語',
    'settings.shellProfiles': 'Shellプロファイル',
    'settings.keyboardShortcuts': 'キーボードショートカット',
    'settings.installShellIntegration': 'Shell統合をインストール',
    'menu.changeColor': '色を変更…',
    'menu.backgroundActivityAlert': 'バックグラウンド活動通知',
    'menu.selectAll': 'すべてを選択',
    'menu.changeProfile': 'プロファイルを変更',
    'menu.pasteImage': '画像を貼り付け',
    'menu.copy': 'コピー',
    'menu.paste': '貼り付け',
    'menu.renameTab': 'タブの名前を変更',
    'menu.closeTab': 'タブを閉じる',
    'msg.shellIntegrationInstalled': 'Shell統合をインストールしました。ソース行をコピーしました — ~/.zshrc または ~/.bashrc に貼り付けてください',
    'msg.shellIntegrationFailed': 'Shell統合のインストールに失敗しました：',
  },
};

export const SUPPORTED_LOCALES = [
  { code: 'en',    label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja',    label: '日本語' },
];

let _locale = 'en';

export function setLocale(code) {
  if (TRANSLATIONS[code]) {
    _locale = code;
  }
}

export function getLocale() {
  return _locale;
}

export function t(key, fallback) {
  return TRANSLATIONS[_locale]?.[key] ?? TRANSLATIONS['en']?.[key] ?? fallback ?? key;
}
