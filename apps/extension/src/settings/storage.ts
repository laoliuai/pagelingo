import { defaultSettings, settingsSchema, type UserSettings } from './schema';

export async function restrictSettingsAccess(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function readSettings(): Promise<UserSettings> {
  await restrictSettingsAccess();
  const { settings } = await chrome.storage.local.get('settings');
  if (settings === undefined) return structuredClone(defaultSettings);
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error('本地设置格式不正确，请在设置页重新保存。');
  return parsed.data;
}

export async function saveSettings(input: UserSettings): Promise<void> {
  const settings = settingsSchema.parse(input);
  await restrictSettingsAccess();
  await chrome.storage.local.set({ settings });
}
