export function createUnreadTitleCycler(companyName: string, unreadCount: number) {
  const notificationTitle =
    unreadCount === 1 ? '1 nytt meddelande' : `${unreadCount} nya meddelanden`;
  let showNotification = false;

  return {
    tick(hidden: boolean) {
      if (!hidden) {
        showNotification = false;
        return companyName;
      }
      showNotification = !showNotification;
      return showNotification ? notificationTitle : companyName;
    },
    reset() {
      showNotification = false;
      return companyName;
    },
  };
}
