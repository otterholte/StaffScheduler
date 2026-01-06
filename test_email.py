"""
Test script for the email service.
Run this to verify email functionality works.
"""

from email_service import EmailService, get_email_service
import os

def test_email_configuration():
    """Test if email service is properly configured."""
    print("=" * 50)
    print("Email Service Configuration Test")
    print("=" * 50)
    
    service = get_email_service()
    
    print(f"\nServer: {service.server}")
    print(f"Port: {service.port}")
    print(f"Username configured: {bool(service.username)}")
    print(f"Password configured: {bool(service.password)}")
    print(f"Is configured: {service.is_configured()}")
    
    if not service.is_configured():
        print("\n[!] Email service is NOT configured.")
        print("To configure, set these environment variables:")
        print("  - MAIL_USERNAME: Your Gmail address")
        print("  - MAIL_PASSWORD: Your Gmail App Password")
        print("\nFor Gmail, you need to:")
        print("  1. Enable 2-factor authentication")
        print("  2. Generate an App Password at https://myaccount.google.com/apppasswords")
        print("  3. Use that app password (NOT your regular Gmail password)")
        return False
    
    print("\n[OK] Email service is configured!")
    return True

def test_send_email(to_email):
    """Test sending an actual email."""
    print("\n" + "=" * 50)
    print("Sending Test Email")
    print("=" * 50)
    
    service = get_email_service()
    
    if not service.is_configured():
        print("[ERROR] Cannot send email - service not configured")
        return False
    
    print(f"\nSending to: {to_email}")
    
    success, message = service.send_portal_invitation(
        to_email=to_email,
        employee_name="Test Employee",
        business_name="Test Coffee Shop",
        portal_url="http://localhost:5000/employee/test-coffee-shop/emp_123/schedule"
    )
    
    if success:
        print(f"[OK] Email sent successfully!")
    else:
        print(f"[ERROR] Failed to send email: {message}")
    
    return success

if __name__ == "__main__":
    import sys
    
    # Test configuration
    configured = test_email_configuration()
    
    # If configured and email provided, send test email
    if configured and len(sys.argv) > 1:
        test_email = sys.argv[1]
        test_send_email(test_email)
    elif configured:
        print("\nTo send a test email, run:")
        print("  python test_email.py your-email@example.com")

