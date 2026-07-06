import nodemailer from "nodemailer";
import axios from "axios";

export class NotificationService {
  private static getMailTransporter() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "587");
    const user = process.env.SMTP_USER || process.env.SMTP_USERNAME;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;

    if (!host || !user || !pass) {
      return null;
    }

    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  }

  /**
   * Dispatches alerts to Telegram and Email admins
   */
  static async sendNotification(subject: string, message: string): Promise<void> {
    console.log(`📢 Notification broadcast: [${subject}] - ${message}`);

    // 1. Dispatch Telegram Bot API Message
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (telegramToken && telegramChatId) {
      const isPlaceholder =
        telegramToken === "your_telegram_bot_token" ||
        telegramChatId === "your_telegram_chat_id" ||
        telegramToken.startsWith("your_") ||
        telegramChatId.startsWith("your_");

      if (isPlaceholder) {
        console.warn("⚠️ Telegram notification skipped: default placeholder credentials detected.");
      } else {
        try {
          const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
          await axios.post(url, {
            chat_id: telegramChatId,
            text: `🔔 *${subject}*\n\n${message}`,
            parse_mode: "Markdown"
          });
          console.log("📨 Telegram alert successfully delivered.");
        } catch (err: any) {
          console.error("❌ Failed to send Telegram alert:", err.message);
        }
      }
    }

    // 2. Dispatch SMTP Email
    const transporter = this.getMailTransporter();
    const adminEmail = process.env.ADMIN_EMAIL;

    if (transporter && adminEmail) {
      try {
        await transporter.sendMail({
          from: `"Mars Algo Platform" <${process.env.SMTP_USER}>`,
          to: adminEmail,
          subject: `Mars Alert: ${subject}`,
          text: message,
          html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 6px;">
                  <h2 style="color: #e74c3c; border-bottom: 2px solid #e74c3c; padding-bottom: 8px; font-weight: normal;">${subject}</h2>
                  <p style="font-size: 15px; line-height: 1.6; color: #2c3e50;">${message.replace(/\n/g, "<br>")}</p>
                 </div>`
        });
        console.log("📨 Email alert successfully delivered.");
      } catch (err: any) {
        console.error("❌ Failed to send email alert:", err.message);
      }
    }
  }

  /**
   * Dispatches custom HTML formatted email directly to the admin
   */
  static async sendHtmlEmail(subject: string, htmlContent: string): Promise<boolean> {
    const transporter = this.getMailTransporter();
    const adminEmail = process.env.ADMIN_EMAIL;

    if (transporter && adminEmail) {
      try {
        await transporter.sendMail({
          from: `"Mars Algo Platform" <${process.env.SMTP_USER}>`,
          to: adminEmail,
          subject,
          html: htmlContent
        });
        console.log("📨 HTML email report successfully delivered.");
        return true;
      } catch (err: any) {
        console.error("❌ Failed to send HTML email report:", err.message);
      }
    }
    return false;
  }
}
