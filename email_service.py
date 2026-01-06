"""
Simple Email Service for Staff Scheduler

Uses Python's built-in smtplib for sending emails.
Works with Gmail SMTP (free, up to 500 emails/day with App Password).

Configuration via environment variables:
- MAIL_SERVER: SMTP server (default: smtp.gmail.com)
- MAIL_PORT: SMTP port (default: 587 for TLS)
- MAIL_USERNAME: Your email address
- MAIL_PASSWORD: App password (NOT your regular password)
- MAIL_FROM_NAME: Display name for sender (default: Staff Scheduler)
"""

import os
import smtplib
import socket
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional, Tuple


class EmailService:
    """Simple email service using SMTP."""
    
    def __init__(self):
        self.server = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
        self.port = int(os.environ.get('MAIL_PORT', 587))
        self.username = os.environ.get('MAIL_USERNAME', '')
        self.password = os.environ.get('MAIL_PASSWORD', '')
        self.from_name = os.environ.get('MAIL_FROM_NAME', 'Staff Scheduler')
        self.enabled = bool(self.username and self.password)
    
    def is_configured(self) -> bool:
        """Check if email is properly configured."""
        return self.enabled
    
    def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None
    ) -> Tuple[bool, str]:
        """
        Send an email.
        
        Returns:
            Tuple of (success: bool, message: str)
        """
        if not self.enabled:
            return False, "Email service not configured. Set MAIL_USERNAME and MAIL_PASSWORD environment variables."
        
        try:
            # Create message
            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From'] = f"{self.from_name} <{self.username}>"
            msg['To'] = to_email
            
            # Add text and HTML parts
            if text_body:
                msg.attach(MIMEText(text_body, 'plain'))
            msg.attach(MIMEText(html_body, 'html'))
            
            # Send email with timeout to prevent Railway from killing the request
            with smtplib.SMTP(self.server, self.port, timeout=10) as server:
                server.starttls()
                server.login(self.username, self.password)
                server.send_message(msg)
            
            return True, "Email sent successfully"
            
        except smtplib.SMTPAuthenticationError:
            return False, "Email authentication failed. Check your MAIL_USERNAME and MAIL_PASSWORD."
        except smtplib.SMTPException as e:
            return False, f"SMTP error: {str(e)}"
        except socket.timeout:
            return False, "Email server connection timed out. Please try again."
        except socket.error as e:
            return False, f"Network error: {str(e)}"
        except Exception as e:
            return False, f"Failed to send email: {str(e)}"
    
    def send_portal_invitation(
        self,
        to_email: str,
        employee_name: str,
        business_name: str,
        portal_url: str
    ) -> Tuple[bool, str]:
        """
        Send a portal invitation email to an employee.
        
        Args:
            to_email: Employee's email address
            employee_name: Employee's name
            business_name: Name of the business
            portal_url: Full URL to the employee portal
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        subject = f"You're invited to view your schedule at {business_name}"
        
        html_body = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5fa;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <tr>
            <td>
                <div style="background: linear-gradient(135deg, #467df6 0%, #a855f7 50%, #e749a0 100%); padding: 3px; border-radius: 16px;">
                    <div style="background-color: #ffffff; border-radius: 14px; padding: 40px;">
                        <!-- Logo/Header -->
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="margin: 0; font-size: 24px; color: #1a1a2e;">
                                📅 Staff Scheduler
                            </h1>
                        </div>
                        
                        <!-- Main Content -->
                        <h2 style="margin: 0 0 15px; font-size: 20px; color: #1a1a2e;">
                            Hi {employee_name}!
                        </h2>
                        
                        <p style="margin: 0 0 20px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            You've been invited to access the employee portal at <strong>{business_name}</strong>.
                        </p>
                        
                        <p style="margin: 0 0 25px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            From the portal, you can:
                        </p>
                        
                        <ul style="margin: 0 0 30px; padding-left: 20px; color: #5a5a70; line-height: 1.8;">
                            <li>View your weekly schedule</li>
                            <li>See who you're working with</li>
                            <li>Update your availability</li>
                        </ul>
                        
                        <!-- CTA Button -->
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{portal_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #467df6 0%, #a855f7 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                View My Schedule
                            </a>
                        </div>
                        
                        <p style="margin: 25px 0 0; font-size: 14px; color: #9090a0; line-height: 1.6;">
                            Or copy and paste this link into your browser:<br>
                            <a href="{portal_url}" style="color: #467df6; word-break: break-all;">{portal_url}</a>
                        </p>
                    </div>
                </div>
                
                <!-- Footer -->
                <p style="text-align: center; margin-top: 30px; font-size: 12px; color: #9090a0;">
                    This email was sent by Staff Scheduler on behalf of {business_name}.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
"""
        
        text_body = f"""
Hi {employee_name}!

You've been invited to access the employee portal at {business_name}.

From the portal, you can:
- View your weekly schedule
- See who you're working with
- Update your availability

Click here to view your schedule:
{portal_url}

---
This email was sent by Staff Scheduler on behalf of {business_name}.
"""
        
        return self.send_email(to_email, subject, html_body, text_body)


# Singleton instance
_email_service = None

def get_email_service() -> EmailService:
    """Get the email service singleton."""
    global _email_service
    if _email_service is None:
        _email_service = EmailService()
    return _email_service

