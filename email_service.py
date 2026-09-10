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
            
            # Resend's API sits behind Cloudflare, which rejects Python's
            # default "Python-urllib" user agent with error 1010. Identify
            # ourselves like a normal HTTP client.
            req = Request(
                "https://api.resend.com/emails",
                data=json.dumps(data).encode('utf-8'),
                headers={
                    "Authorization": f"Bearer {self.resend_api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "StaffScheduler/2.0 (+https://thestaffscheduler.com)",
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
        resend_error = None
        if self.use_resend:
            success, msg = self._send_via_resend(to_email, subject, html_body, text_body)
            if success:
                return success, msg
            resend_error = msg
            print(f"[EMAIL] Resend failed: {msg}", flush=True)

        # Fall back to SMTP (usually blocked on cloud hosts, so keep the Resend
        # error in the message rather than hiding it behind a network error)
        if self.use_smtp:
            success, msg = self._send_via_smtp(to_email, subject, html_body, text_body)
            if success or not resend_error:
                return success, msg
            return False, f"{resend_error} (SMTP fallback also failed: {msg})"

        return False, resend_error or "No email method available"
    
    def send_portal_invitation(
        self,
        to_email: str,
        employee_name: str,
        business_name: str,
        portal_url: str,
        login_url: Optional[str] = None,
        temp_password: Optional[str] = None
    ) -> Tuple[bool, str]:
        """
        Send a portal invitation email to an employee.
        
        Args:
            to_email: Employee's email address
            employee_name: Employee's name
            business_name: Name of the business
            portal_url: Full URL to the employee portal
            login_url: URL to the login page (optional)
            temp_password: Temporary password for first login (optional, if None user already has account)
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        subject = f"You're invited to view your schedule at {business_name}"
        
        # Build login credentials section if temp_password provided
        if temp_password and login_url:
            credentials_html = f"""
                        <div style="background-color: #f0f4ff; border: 1px solid #467df6; border-radius: 10px; padding: 20px; margin: 20px 0;">
                            <h3 style="margin: 0 0 15px; font-size: 16px; color: #1a1a2e;">
                                🔐 Your Login Credentials
                            </h3>
                            <p style="margin: 0 0 10px; font-size: 14px; color: #5a5a70;">
                                <strong>Email:</strong> {to_email}
                            </p>
                            <p style="margin: 0 0 15px; font-size: 14px; color: #5a5a70;">
                                <strong>Temporary Password:</strong> <code style="background: #e0e0e0; padding: 2px 8px; border-radius: 4px; font-family: monospace;">{temp_password}</code>
                            </p>
                            <p style="margin: 0; font-size: 13px; color: #e74c3c;">
                                ⚠️ You'll be asked to change your password on first login.
                            </p>
                        </div>
                        
                        <!-- Login Button -->
                        <div style="text-align: center; margin: 25px 0;">
                            <a href="{login_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #467df6 0%, #a855f7 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                Log In Now
                            </a>
                        </div>
"""
            credentials_text = f"""
YOUR LOGIN CREDENTIALS
----------------------
Email: {to_email}
Temporary Password: {temp_password}

⚠️ You'll be asked to change your password on first login.

Log in here: {login_url}
"""
        else:
            credentials_html = """
                        <!-- CTA Button -->
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{portal_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #467df6 0%, #a855f7 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                View My Schedule
                            </a>
                        </div>
""".format(portal_url=portal_url)
            credentials_text = ""
        
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
                            <li>Request time off</li>
                            <li>Request shift swaps</li>
                        </ul>
                        
                        {credentials_html}
                        
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
- Request time off
- Request shift swaps
{credentials_text}
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


    def send_password_reset(
        self,
        to_email: str,
        user_name: str,
        reset_url: str
    ) -> Tuple[bool, str]:
        """
        Send a password reset email.
        
        Args:
            to_email: User's email address
            user_name: User's name or username
            reset_url: Full URL to reset password page
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        subject = "Reset your Staff Scheduler password"
        
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
                                🔐 Password Reset
                            </h1>
                        </div>
                        
                        <!-- Main Content -->
                        <h2 style="margin: 0 0 15px; font-size: 20px; color: #1a1a2e;">
                            Hi {user_name}!
                        </h2>
                        
                        <p style="margin: 0 0 20px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            We received a request to reset your password for your Staff Scheduler account.
                        </p>
                        
                        <p style="margin: 0 0 25px; font-size: 16px; color: #5a5a70; line-height: 1.6;">
                            Click the button below to create a new password. This link will expire in 1 hour.
                        </p>
                        
                        <!-- CTA Button -->
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{reset_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #467df6 0%, #a855f7 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                Reset Password
                            </a>
                        </div>
                        
                        <p style="margin: 25px 0 0; font-size: 14px; color: #9090a0; line-height: 1.6;">
                            Or copy and paste this link into your browser:<br>
                            <a href="{reset_url}" style="color: #467df6; word-break: break-all;">{reset_url}</a>
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">
                        
                        <p style="margin: 0; font-size: 14px; color: #9090a0; line-height: 1.6;">
                            If you didn't request this password reset, you can safely ignore this email. Your password will not be changed.
                        </p>
                    </div>
                </div>
                
                <!-- Footer -->
                <p style="text-align: center; margin-top: 30px; font-size: 12px; color: #9090a0;">
                    This email was sent by Staff Scheduler.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
"""
        
        text_body = f"""
Hi {user_name}!

We received a request to reset your password for your Staff Scheduler account.

Click the link below to create a new password. This link will expire in 1 hour.

{reset_url}

If you didn't request this password reset, you can safely ignore this email. Your password will not be changed.

---
This email was sent by Staff Scheduler.
"""
        
        return self.send_email(to_email, subject, html_body, text_body)


    def send_notification(
        self,
        to_email: str,
        subject: str,
        title: str,
        greeting: str,
        intro: str,
        detail_lines: Optional[list] = None,
        cta_text: Optional[str] = None,
        cta_url: Optional[str] = None,
        footer_note: str = "",
        accent_start: str = "#467df6",
        accent_end: str = "#a855f7",
    ) -> Tuple[bool, str]:
        """Generic branded notification email used for PTO, counter offers,
        published schedules, and anything new we add later.

        `detail_lines` is a list of short strings rendered in a highlighted box.
        """
        details_html = ""
        if detail_lines:
            rows = "".join(
                f'<p style="margin: 0 0 8px; font-size: 16px; color: #374151; font-weight: 600;">{line}</p>'
                for line in detail_lines
            )
            details_html = f"""
                        <div style="background-color: #f3f4f6; border-radius: 10px; padding: 18px 20px; margin: 22px 0; border-left: 4px solid {accent_start};">
                            {rows}
                        </div>
"""
        cta_html = ""
        if cta_text and cta_url:
            cta_html = f"""
                        <div style="text-align: center; margin: 28px 0;">
                            <a href="{cta_url}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, {accent_start} 0%, {accent_end} 100%); color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                                {cta_text}
                            </a>
                        </div>
                        <p style="margin: 10px 0 0; font-size: 13px; color: #9090a0; line-height: 1.6; text-align: center;">
                            Or open this link: <a href="{cta_url}" style="color: {accent_start}; word-break: break-all;">{cta_url}</a>
                        </p>
"""
        footer_html = f'<p style="margin: 25px 0 0; font-size: 14px; color: #9090a0; line-height: 1.6;">{footer_note}</p>' if footer_note else ""

        html_body = f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5fa;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <tr><td>
            <div style="background: linear-gradient(135deg, {accent_start} 0%, {accent_end} 100%); padding: 3px; border-radius: 16px;">
                <div style="background-color: #ffffff; border-radius: 14px; padding: 40px;">
                    <div style="text-align: center; margin-bottom: 26px;">
                        <h1 style="margin: 0; font-size: 24px; color: #1a1a2e;">{title}</h1>
                    </div>
                    <h2 style="margin: 0 0 15px; font-size: 20px; color: #1a1a2e;">{greeting}</h2>
                    <p style="margin: 0 0 12px; font-size: 16px; color: #5a5a70; line-height: 1.6;">{intro}</p>
                    {details_html}
                    {cta_html}
                    {footer_html}
                </div>
            </div>
            <p style="text-align: center; margin-top: 30px; font-size: 12px; color: #9090a0;">
                This email was sent by Staff Scheduler.
            </p>
        </td></tr>
    </table>
</body>
</html>
"""
        text_lines = [greeting, "", intro, ""]
        if detail_lines:
            text_lines.extend(detail_lines)
            text_lines.append("")
        if cta_text and cta_url:
            text_lines.append(f"{cta_text}: {cta_url}")
            text_lines.append("")
        if footer_note:
            text_lines.append(footer_note)
        text_body = "\n".join(text_lines)
        return self.send_email(to_email, subject, html_body, text_body)


    def send_schedule_email(
        self,
        to_email: str,
        first_name: str,
        business_name: str,
        week_label: str,
        days: list,
        shift_count: int,
        total_hours: float,
        portal_url: str,
        footer_note: str = "",
    ) -> Tuple[bool, str]:
        """The published-schedule email: one row per day so a team member can
        read their week at a glance on a phone.

        `days`: [{label:'Mon', date:'Sep 7', closed:bool,
                  shifts:[{time:'5pm-10pm', role:'Server', color:'#f97316', hours:5}]}]
        """
        def esc(v):
            return (str(v or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

        hours_txt = f"{total_hours:g}"
        if shift_count == 0:
            summary_txt = "No shifts this week"
            summary_bg, summary_fg = "#f1f5f9", "#475569"
        else:
            summary_txt = f"{shift_count} shift{'s' if shift_count != 1 else ''} · {hours_txt} hours"
            summary_bg, summary_fg = "#d1fae5", "#047857"

        rows = []
        for d in days:
            shifts = d.get('shifts') or []
            if d.get('closed'):
                body = '<span style="font-size:15px;color:#b0b5c3;">Closed</span>'
                bg = "#ffffff"
            elif not shifts:
                body = '<span style="font-size:15px;color:#9aa0ae;">Off</span>'
                bg = "#ffffff"
            else:
                parts = []
                for sh in shifts:
                    color = esc(sh.get('color') or '#10b981')
                    parts.append(
                        f'<div style="margin:0 0 8px;padding:8px 12px;border-left:4px solid {color};'
                        f'background:#f8fafc;border-radius:0 8px 8px 0;">'
                        f'<div style="font-size:17px;font-weight:700;color:#0f172a;line-height:1.3;">{esc(sh.get("time"))}</div>'
                        f'<div style="font-size:13px;color:#475569;margin-top:2px;">'
                        f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{color};margin-right:6px;vertical-align:middle;"></span>'
                        f'<span style="font-weight:600;color:#1e293b;">{esc(sh.get("role") or "Shift")}</span>'
                        f'&nbsp;·&nbsp;{esc(sh.get("hours"))}h</div></div>'
                    )
                body = "".join(parts)
                bg = "#ffffff"
            day_color = "#0f172a" if shifts else "#9aa0ae"
            rows.append(
                f'<tr style="background:{bg};">'
                f'<td style="width:58px;padding:14px 8px 14px 4px;vertical-align:top;border-bottom:1px solid #eef0f6;text-align:center;">'
                f'<div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:{"#475569" if shifts else "#b0b5c3"};">{esc(d.get("label"))}</div>'
                f'<div style="font-size:24px;font-weight:700;color:{day_color};line-height:1.1;">{esc(d.get("day_num"))}</div>'
                f'</td>'
                f'<td style="padding:12px 4px 8px 10px;vertical-align:middle;border-bottom:1px solid #eef0f6;">{body}</td>'
                f'</tr>'
            )
        rows_html = "".join(rows)

        html_body = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your schedule</title></head>
<body style="margin:0;padding:0;background:#f4f5fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;">
<tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,0.06);">
  <tr><td style="padding:22px 22px 6px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;">{esc(business_name)}</div>
    <div style="font-size:26px;font-weight:800;color:#0f172a;margin-top:4px;line-height:1.2;">Your schedule</div>
    <div style="font-size:15px;color:#475569;margin-top:2px;">{esc(week_label)}</div>
    <div style="display:inline-block;margin-top:12px;padding:6px 12px;border-radius:999px;background:{summary_bg};color:{summary_fg};font-size:14px;font-weight:700;">{esc(summary_txt)}</div>
  </td></tr>
  <tr><td style="padding:6px 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">{rows_html}</table>
  </td></tr>
  <tr><td style="padding:18px 22px 6px;">
    <a href="{esc(portal_url)}" style="display:block;text-align:center;padding:15px 20px;background:#10b981;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:700;font-size:16px;">Open my schedule</a>
    <p style="margin:12px 0 0;font-size:13px;color:#64748b;line-height:1.5;text-align:center;">Need a day covered? Open your schedule and tap <strong>Swap</strong> on the shift.</p>
  </td></tr>
  <tr><td style="padding:10px 22px 22px;">
    <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;text-align:center;">{esc(footer_note)}</p>
  </td></tr>
</table>
<p style="margin:16px 0 0;font-size:11px;color:#a3a8b8;">Sent by Staff Scheduler for {esc(business_name)}. If the button doesn't work, open: {esc(portal_url)}</p>
</td></tr>
</table>
</body>
</html>"""

        text_lines = [f"Hi {first_name}, here's your schedule for {week_label} at {business_name}.", ""]
        for d in days:
            shifts = d.get('shifts') or []
            if d.get('closed'):
                desc = "Closed"
            elif not shifts:
                desc = "Off"
            else:
                desc = "; ".join(f"{sh.get('time')} {sh.get('role') or ''} ({sh.get('hours')}h)".strip() for sh in shifts)
            text_lines.append(f"{d.get('label')} {d.get('date')}: {desc}")
        text_lines += ["", summary_txt, "", f"Open my schedule: {portal_url}"]
        if footer_note:
            text_lines += ["", footer_note]
        subject = f"Your schedule for {week_label}: {summary_txt.replace(' · ', ', ').lower() if shift_count else 'no shifts'}"
        return self.send_email(to_email, subject, html_body, "\n".join(text_lines))


# Singleton instance
_email_service = None

def get_email_service() -> EmailService:
    """Get the email service singleton."""
    global _email_service
    if _email_service is None:
        _email_service = EmailService()
    return _email_service

