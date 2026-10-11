import { defineManifest } from '@crxjs/vite-plugin';
import extensionPackage from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'PageLingo',
  version: extensionPackage.version,
  description: '翻译科技文章，在侧栏结合原文、代码和引用持续对话。',
  minimum_chrome_version: '120',
  permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'alarms', 'sidePanel'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'],
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  action: { default_popup: 'src/popup/index.html', default_title: 'PageLingo' },
  options_ui: { page: 'src/options/index.html', open_in_tab: true },
  side_panel: { default_path:'src/sidepanel/index.html' },
});
