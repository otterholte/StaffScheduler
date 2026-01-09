"""
Simple Email Service for Staff Scheduler

Supports two methods:
1. Resend API (recommended for cloud platforms like Railway)
2. SMTP (Gmail, etc.) - may be blocked on some cloud platforms

Configuration via environment variables:
- RESEND_API_KEY: API key from resend.com (recommended)
- MAIL_SERVER: SMTP server (default: smtp.gmail.com)
- MAIL_PORT: SMTP port (default: 587 for TLS, use 465 for SSL)
- MAIL_USERNAME: Your email address
- MAIL_PASSWORD: App password (NOT your regular password)
- MAIL_FROM_NAME: Display name for sender (default: Staff Scheduler)
"""

import os
import smtplib
import socket
import json
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional, Tuple
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError


class EmailService:
    """Email service supporting Resend API and SMTP."""
    
    def __init__(self):
        # Resend API (preferred for cloud platforms)
        self.resend_api_key = os.environ.get('RESEND_API_KEY', '')
        self.resend_from_email = os.environ.get('RESEND_FROM_EMAIL', 'onboarding@resend.dev')
        
        # SMTP settings (fallback)
        self.server = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
        self.port = int(os.environ.get('MAIL_PORT', 587))
        self.username = os.environ.get('MAIL_USERNAME', '')
        self.password = os.environ.get('MAIL_PASSWORD', '')
        self.from_name = os.environ.get('MAIL_FROM_NAME', 'Staff Scheduler')
        
        # Check which method is available
        self.use_resend = bool(self.resend_api_key)
        self.use_smtp = bool(self.username and self.password)
        self.enabled = self.use_resend or self.use_smtp
    
    def is_configured(self) -> bool:
        """Check if email is properly configured."""
        return self.enabled
    
    def _send_via_resend(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None
    ) -> Tuple[bool, str]:
        """Send email via Resend API."""
        try:
            data = {
                "from": f"{self.from_name} <{self.resend_from_email}>",
                "to": [to_email],
                "subject": subject,
                "html": html_body
            }
            if text_body:
                data["text"] = text_body
            
            req = Request(
                "https://api.resend.com/emails",
                data=json.dumps(data).encode('utf-8'),
                headers={
                    "Authorization": f"Bearer {self.resend_api_key}",
                    "Content-Type": "application/json"
                },
                method="POST"
            )
            
            with urlopen(req, timeout=15) as response:
                result = json.loads(response.read().decode('utf-8'))
                return True, f"Email sent via Resend (id: {result.get('id', 'unknown')})"
                
        except HTTPError as e:
            error_body = e.read().decode('utf-8') if e.fp else str(e)
            return False, f"Resend API error ({e.code}): {error_body}"
        except URLError as e:
            return False, f"Resend network error: {str(e.reason)}"
        except Exception as e:
            return False, f"Resend error: {str(e)}"
    
    def _send_via_smtp(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None
    ) -> Tuple[bool, str]:
        """Send email via SMTP."""
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
            
            # Send email with timeout
            if self.port == 465:
                with smtplib.SMTP_SSL(self.server, self.port, timeout=15) as server:
                    server.login(self.username, self.password)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(self.server, self.port, timeout=15) as server:
                    server.starttls()
                    server.login(self.username, self.password)
                    server.send_message(msg)
            
            return True, "Email sent via SMTP"
            
        except smtplib.SMTPAuthenticationError:
            return False, "SMTP authentication failed. Check your MAIL_USERNAME and MAIL_PASSWORD."
        except smtplib.SMTPException as e:
            return False, f"SMTP error: {str(e)}"
        except socket.timeout:
            return False, "SMTP connection timed out."
        except socket.error as e:
            return False, f"SMTP network error: {str(e)}"
        except Exception as e:
            return False, f"SMTP error: {str(e)}"
    
    def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None
    ) -> Tuple[bool, str]:
        """
        Send an email. Tries Resend API first, then falls back to SMTP.
        
        Returns:
            Tuple of (success: bool, message: str)
        """
        if not self.enabled:
            return False, "Email service not configured. Set RESEND_API_KEY or MAIL_USERNAME/MAIL_PASSWORD."
        
        # Try Resend API first (works on cloud platforms like Railway)
        if self.use_resend:
            success, msg = self._send_via_resend(to_email, subject, html_body, text_body)
            if success:
                return success, msg
            # Log Resend failure but continue to SMTP fallback
            print(f"[EMAIL] Resend failed: {msg}", flush=True)
        
        # Fall back to SMTP
        if self.use_smtp:
            return self._send_via_smtp(to_email, subject, html_body, text_body)
        
        return False, "No email method available"
    
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
    
    def send_swap_request_notification(
        self,
        to_email: str,
        recipient_name: str,
        requester_name: str,
        business_name: str,
        shift_details: str,
        eligibility_type: str,  # 'pickup' or 'swap_only'
        portal_url: str
    ) -> Tuple[bool, str]:
        """
        Send a shift swap request notification to an eligible employee.
        
        Args:
            to_email: Recipient's email address
            recipient_name: Recipient's name
            requester_name: Name of the person requesting the swap
            business_name: Name of the business
            shift_details: Description of the shift (e.g., "Monday 9am-5pm")
            eligibility_type: 'pickup' or 'swap_only'
            portal_url: Full URL to the employee portal
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        subject = f"Shift available: {shift_details} at {business_name}"
        
        action_text = "pick up this shift" if eligibility_type == 'pickup' else "swap for this shift"
        
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
                <div style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); padding: 3px; border-radius: 16px;">
                    <div style="background-color: #ffffff; border-radius: 14px; padding: 40px;">
                        <!-- Logo/Header -->
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="margin: 0; font-size: 24px; color: #1a1a2e;">
                                🔄 Shift Swap Request
                            </h1>
                        </div>
                        
                        <!-- Main Content -->
                        <h2 style="margin: 0 0 15px; font-size: 20px; color: #1a1a2e;">
                            Hi {recipient_name}!
                        </h2>
                        
                        <p style="margin: 0 0 20px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            <strong>{requester_name}</strong> is looking for someone to cover their shift at <strong>{business_name}</strong>.
                        </p>
                        
                        <!-- Shift Details Box -->
                        <div style="background-color: #fef3c7; border-radius: 10px; padding: 20px; margin: 25px 0; border-left: 4px solid #f59e0b;">
                            <p style="margin: 0; font-size: 18px; color: #92400e; font-weight: 600;">
                                📅 {shift_details}
                            </p>
                        </div>
                        
                        <p style="margin: 0 0 25px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            You can <strong>{action_text}</strong>. Tap the button below to respond.
                        </p>
                        
                        <!-- CTA Button -->
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{portal_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                View Swap Request
                            </a>
                        </div>
                        
                        <p style="margin: 25px 0 0; font-size: 14px; color: #9090a0; line-height: 1.6;">
                            Or copy and paste this link into your browser:<br>
                            <a href="{portal_url}" style="color: #f59e0b; word-break: break-all;">{portal_url}</a>
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
Hi {recipient_name}!

{requester_name} is looking for someone to cover their shift at {business_name}.

Shift Details:
{shift_details}

You can {action_text}. Click here to respond:
{portal_url}

---
This email was sent by Staff Scheduler on behalf of {business_name}.
"""
        
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_swap_response_notification(
        self,
        to_email: str,
        requester_name: str,
        responder_name: str,
        business_name: str,
        shift_details: str,
        response: str,  # 'accepted' or 'declined'
        swap_shift_details: Optional[str],  # Details of swap shift if it was a swap
        portal_url: str
    ) -> Tuple[bool, str]:
        """
        Send notification to requester when someone responds to their swap request.
        """
        if response == 'accepted':
            subject = f"Great news! {responder_name} accepted your shift swap"
            emoji = "✅"
            action = "accepted"
            color_start = "#10b981"
            color_end = "#059669"
        else:
            subject = f"{responder_name} declined your shift swap request"
            emoji = "❌"
            action = "declined"
            color_start = "#ef4444"
            color_end = "#dc2626"
        
        swap_info = ""
        if swap_shift_details and response == 'accepted':
            swap_info = f"""
                        <div style="background-color: #e0f2fe; border-radius: 10px; padding: 20px; margin: 15px 0; border-left: 4px solid #0ea5e9;">
                            <p style="margin: 0; font-size: 16px; color: #0369a1; font-weight: 600;">
                                🔄 In exchange, you'll take their shift: {swap_shift_details}
                            </p>
                        </div>
"""
        
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
                <div style="background: linear-gradient(135deg, {color_start} 0%, {color_end} 100%); padding: 3px; border-radius: 16px;">
                    <div style="background-color: #ffffff; border-radius: 14px; padding: 40px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="margin: 0; font-size: 24px; color: #1a1a2e;">
                                {emoji} Swap Request {action.title()}
                            </h1>
                        </div>
                        
                        <h2 style="margin: 0 0 15px; font-size: 20px; color: #1a1a2e;">
                            Hi {requester_name}!
                        </h2>
                        
                        <p style="margin: 0 0 20px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            <strong>{responder_name}</strong> has {action} your request to swap the shift:
                        </p>
                        
                        <div style="background-color: #f3f4f6; border-radius: 10px; padding: 20px; margin: 25px 0;">
                            <p style="margin: 0; font-size: 18px; color: #374151; font-weight: 600;">
                                📅 {shift_details}
                            </p>
                        </div>
                        
                        {swap_info}
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{portal_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, {color_start} 0%, {color_end} 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                View Updated Schedule
                            </a>
                        </div>
                    </div>
                </div>
                
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
Hi {requester_name}!

{responder_name} has {action} your request to swap the shift:
{shift_details}

{"In exchange, you'll take their shift: " + swap_shift_details if swap_shift_details and response == 'accepted' else ""}

View your updated schedule:
{portal_url}

---
This email was sent by Staff Scheduler on behalf of {business_name}.
"""
        
        return self.send_email(to_email, subject, html_body, text_body)

    def send_swap_completed_manager_notification(
        self,
        to_email: str,
        manager_name: str,
        requester_name: str,
        accepter_name: str,
        business_name: str,
        shift_details: str,
        swap_shift_details: Optional[str],
        schedule_url: str
    ) -> Tuple[bool, str]:
        """
        Send notification to manager when a shift swap is completed.
        """
        subject = f"Shift swap completed: {requester_name} ↔ {accepter_name}"
        
        swap_info = ""
        if swap_shift_details:
            swap_info = f"""
                        <div style="background-color: #e0f2fe; border-radius: 10px; padding: 15px; margin: 15px 0; border-left: 4px solid #0ea5e9;">
                            <p style="margin: 0; font-size: 14px; color: #0369a1;">
                                🔄 <strong>{accepter_name}</strong> traded their shift: {swap_shift_details}
                            </p>
                        </div>
"""
        
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
                <div style="background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%); padding: 3px; border-radius: 16px;">
                    <div style="background-color: #ffffff; border-radius: 14px; padding: 40px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="margin: 0; font-size: 24px; color: #1a1a2e;">
                                📋 Shift Swap Completed
                            </h1>
                        </div>
                        
                        <p style="font-size: 16px; color: #4a4a5a; margin: 0 0 20px;">
                            Hi {manager_name},
                        </p>
                        
                        <p style="font-size: 16px; color: #4a4a5a; margin: 0 0 20px;">
                            A shift swap has been completed at <strong>{business_name}</strong>. The schedule has been automatically updated.
                        </p>
                        
                        <div style="background-color: #f3e8ff; border-radius: 10px; padding: 20px; margin: 20px 0;">
                            <p style="margin: 0 0 10px; font-size: 16px; color: #1a1a2e;">
                                <strong>Original shift:</strong> {shift_details}
                            </p>
                            <p style="margin: 0 0 10px; font-size: 14px; color: #6b6b7b;">
                                <span style="text-decoration: line-through;">{requester_name}</span> → <strong style="color: #7c3aed;">{accepter_name}</strong>
                            </p>
                        </div>
                        
                        {swap_info}
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{schedule_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                View Updated Schedule
                            </a>
                        </div>
                        
                        <p style="font-size: 14px; color: #6b6b7b; margin: 20px 0 0; text-align: center;">
                            No action is required - this is for your records.
                        </p>
                    </div>
                </div>
                
                <p style="text-align: center; margin-top: 30px; font-size: 12px; color: #9090a0;">
                    This notification was sent by Staff Scheduler.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
"""
        
        text_body = f"""
Hi {manager_name},

A shift swap has been completed at {business_name}. The schedule has been automatically updated.

Original shift: {shift_details}
{requester_name} → {accepter_name}

{"In exchange, " + accepter_name + " traded their shift: " + swap_shift_details if swap_shift_details else ""}

View the updated schedule:
{schedule_url}

No action is required - this is for your records.

---
This notification was sent by Staff Scheduler.
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

