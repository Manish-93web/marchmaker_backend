import { Types } from "mongoose";
import {
  SupportTicket,
  ISupportTicket,
  TicketPriority,
  TicketStatus,
} from "../models/SupportTicket.js";
import { Notification } from "../models/Notification.js";

export class SupportService {
  static async createTicket(data: {
    userId: string;
    subject: string;
    category: "PROFILE" | "VERIFICATION" | "INTRODUCTION" | "PAYMENT" | "PRIVACY" | "OTHER";
    priority?: TicketPriority;
    initialMessage: string;
  }): Promise<ISupportTicket> {
    const ticketNumber = `TICK-${Math.floor(100000 + Math.random() * 900000)}`;

    const ticket = await SupportTicket.create({
      ticketNumber,
      userId: new Types.ObjectId(data.userId),
      subject: data.subject,
      category: data.category,
      priority: data.priority || "MEDIUM",
      status: "OPEN",
      messages: [
        {
          senderId: new Types.ObjectId(data.userId),
          senderRole: "MEMBER",
          message: data.initialMessage,
          sentAt: new Date(),
        },
      ],
    });

    return ticket;
  }

  static async getTicketsForUser(userId: string) {
    return SupportTicket.find({ userId }).sort({ updatedAt: -1 });
  }

  static async getTicketById(ticketId: string): Promise<ISupportTicket | null> {
    return SupportTicket.findById(ticketId).populate("userId", "fullName email");
  }

  static async replyToTicket(data: {
    ticketId: string;
    senderId: string;
    senderRole: string;
    message: string;
  }): Promise<ISupportTicket> {
    const ticket = await SupportTicket.findById(data.ticketId);
    if (!ticket) {
      throw new Error("Support ticket not found");
    }

    ticket.messages.push({
      senderId: new Types.ObjectId(data.senderId),
      senderRole: data.senderRole,
      message: data.message,
      sentAt: new Date(),
    });

    if (data.senderRole !== "MEMBER" && ticket.status === "OPEN") {
      ticket.status = "IN_PROGRESS";
    }

    await ticket.save();

    // If support staff replied, notify the member
    if (data.senderRole !== "MEMBER") {
      await Notification.create({
        userId: ticket.userId,
        title: `Reply on Support Ticket #${ticket.ticketNumber}`,
        message: "Our support specialist has responded to your ticket.",
        category: "SUPPORT",
        deepLink: "/dashboard/support",
      });
    }

    return ticket;
  }

  static async updateTicketStatus(ticketId: string, status: TicketStatus): Promise<ISupportTicket> {
    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) {
      throw new Error("Support ticket not found");
    }

    ticket.status = status;
    if (status === "RESOLVED" || status === "CLOSED") {
      ticket.resolvedAt = new Date();
    }

    await ticket.save();
    return ticket;
  }

  static async getAllTickets(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [tickets, total] = await Promise.all([
      SupportTicket.find()
        .populate("userId", "fullName email")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit),
      SupportTicket.countDocuments(),
    ]);

    return { tickets, total, page, totalPages: Math.ceil(total / limit) };
  }
}
