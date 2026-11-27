/** Flag VITE_UNREAD_TITLE (off by default); only real workspaces, never the demo data. */
export function unreadTitleEnabled(flag: string | undefined, mode: 'demo' | 'real') {
  return flag === 'true' && mode === 'real';
}

export function unreadTitleText(unreadCount: number) {
  return unreadCount === 1 ? '1 nytt meddelande' : `${unreadCount} nya meddelanden`;
}

/**
 * Alternates a hidden tab's title between the unread count and the page's own title (captured when the tab was
 * hidden, so route titles like "estim · Inkorg" come back unchanged). With nothing unread it shows the page title.
 */
export function createUnreadTitleCycler(baseTitle: string) {
  let showNotification = false;
  return {
    tick(unreadCount: number) {
      if (unreadCount <= 0) {
        showNotification = false;
        return baseTitle;
      }
      showNotification = !showNotification;
      return showNotification ? unreadTitleText(unreadCount) : baseTitle;
    },
    reset() {
      showNotification = false;
      return baseTitle;
    },
  };
}
