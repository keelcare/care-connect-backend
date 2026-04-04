import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('MAIL_HOST'),
      port: this.configService.get<number>('MAIL_PORT'),
      secure: this.configService.get<number>('MAIL_PORT') === 465, // true for 465, false for other ports
      auth: {
        user: this.configService.get<string>('MAIL_USER'),
        pass: this.configService.get<string>('MAIL_PASS'),
      },
    });

    // Verify connection configuration
    this.transporter.verify((error) => {
      if (error) {
        this.logger.warn('Mail server connection failed. Emails might not be sent.', error);
      } else {
        this.logger.log('Mail server is ready to take our messages');
      }
    });
  }

  async sendMail(to: string, subject: string, template: string, context: any) {
    const from = this.configService.get<string>('MAIL_FROM') || 'noreply@careconnect.com';
    
    // Simple HTML generation for now (can be replaced with ejs/handlebars later if needed)
    let body = template;
    Object.keys(context).forEach(key => {
      const placeholder = new RegExp(`{{${key}}}`, 'g');
      body = body.replace(placeholder, context[key]);
    });

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject,
        html: body,
      });
      this.logger.log(`Email sent to ${to} with subject: ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}`, error);
      // Fallback to console log for transparency during dev
      this.logger.log(`[FALLBACK LOG] To: ${to}, Subject: ${subject}, Body: ${body}`);
    }
  }

  async sendVerificationEmail(to: string, token: string, frontendUrl: string) {
    const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;
    const subject = 'Verify your CareConnect Account';
    const template = `
      <h1>Welcome to CareConnect</h1>
      <p>Please click the link below to verify your email address:</p>
      <a href="{{verificationUrl}}">Verify Email</a>
      <p>If you did not request this, please ignore this email.</p>
    `;
    await this.sendMail(to, subject, template, { verificationUrl });
  }

  async sendPasswordResetEmail(to: string, token: string, frontendUrl: string) {
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
    const subject = 'Reset your CareConnect Password';
    const template = `
      <h1>CareConnect Password Reset</h1>
      <p>You requested to reset your password. Click the link below to proceed:</p>
      <a href="{{resetUrl}}">Reset Password</a>
      <p>If you did not request this, please ignore this email.</p>
    `;
    await this.sendMail(to, subject, template, { resetUrl });
  }

  async sendBookingConfirmationEmail(
    to: string,
    userName: string,
    role: 'parent' | 'nanny',
    details: {
      date: string;
      time: string;
      duration: number;
      location: string;
      otherPartyName: string;
    }
  ) {
    const subject = `Booking Confirmed - ${details.date}`;
    const template = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #2c3e50;">Booking Confirmed!</h2>
        <p>Hello ${userName},</p>
        <p>Great news! Your booking for <strong>${details.date}</strong> has been confirmed.</p>
        
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #34495e;">Booking Details</h3>
          <p><strong>${role === 'parent' ? 'Nanny' : 'Parent'}:</strong> ${details.otherPartyName}</p>
          <p><strong>Date:</strong> ${details.date}</p>
          <p><strong>Start Time:</strong> ${details.time}</p>
          <p><strong>Duration:</strong> ${details.duration} hours</p>
          <p><strong>Location:</strong> ${details.location}</p>
        </div>
        
        <p>You can view more details and chat with ${details.otherPartyName} in the CareConnect app.</p>
        <p style="color: #7f8c8d; font-size: 0.9em; margin-top: 30px;">
          Thank you for using CareConnect!<br>
          <i>The CareConnect Team</i>
        </p>
      </div>
    `;

    await this.sendMail(to, subject, template, {});
  }

  async sendCancellationEmail(
    to: string,
    userName: string,
    role: 'parent' | 'nanny',
    details: {
      date: string;
      reason: string;
      otherPartyName: string;
      cancelledBy: 'parent' | 'nanny';
    }
  ) {
    const subject = `Booking Cancelled - ${details.date}`;
    const cancelledByRole = details.cancelledBy === 'parent' ? 'Parent' : 'Nanny';
    
    const template = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #e74c3c;">Booking Cancelled</h2>
        <p>Hello ${userName},</p>
        <p>Unfortunately, your booking for <strong>${details.date}</strong> has been cancelled by the ${cancelledByRole} (${details.otherPartyName}).</p>
        
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #34495e;">Cancellation Details</h3>
          <p><strong>Reason provided:</strong> ${details.reason || 'No reason provided'}</p>
        </div>
        
        <p>If you have any questions or need further assistance, please reach out to CareConnect support.</p>
        <p style="color: #7f8c8d; font-size: 0.9em; margin-top: 30px;">
          Thank you for using CareConnect,<br>
          <i>The CareConnect Team</i>
        </p>
      </div>
    `;

    await this.sendMail(to, subject, template, {});
  }
}
