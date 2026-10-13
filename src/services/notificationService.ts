import { Notification, INotification } from "../models/Notification.js";

export class NotificationService {
  static async getNotificationsForUser(userId: string, limit = 30) {
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    return { notifications, unreadCount };
  }

  static async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    await Notification.updateOne({ _id: notificationId, userId }, { isRead: true });
    return true;
  }

  static async markAllAsRead(userId: string): Promise<boolean> {
    await Notification.updateMany({ userId, isRead: false }, { isRead: true });
    return true;
  }
}
