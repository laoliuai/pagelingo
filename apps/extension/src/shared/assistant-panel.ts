export const assistantPanelPath = (tabId: number) => `src/sidepanel/index.html?tabId=${tabId}`;

/** Dispatch both calls during the original user gesture, before page capture. */
export function openAssistantPanel(tabId: number): Promise<void> {
  const configured = chrome.sidePanel.setOptions({
    tabId,
    path: assistantPanelPath(tabId),
    enabled: true,
  });
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([configured, opened]).then(() => {});
}
