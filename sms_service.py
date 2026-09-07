"""
SMS notifications via Twilio.

Twilio is optional. When the three environment variables below are missing the
service reports itself as "not configured" and every send is a harmless no-op,
so the rest of the app never has to special-case it.

Environment variables:
    TWILIO_ACCOUNT_SID   - from the Twilio console
    TWILIO_AUTH_TOKEN    - from the Twilio console
    TWILIO_FROM_NUMBER   - your Twilio phone number in E.164 form (+15551234567)
                           OR
    TWILIO_MESSAGING_SERVICE_SID - a Messaging Service SID (preferred for scale)

No third-party package is needed; we call Twilio's REST API with urllib.
"""

import base64
import json
import os
import re
from typing import Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def normalize_phone(raw: Optional[str], default_country_code: str = "1") -> Optional[str]:
    """Turn '(555) 123-4567' into '+15551234567'. Returns None if unusable."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None
    if raw.strip().startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return f"+{default_country_code}{digits}"
    if len(digits) == 11 and digits.startswith(default_country_code):
        return "+" + digits
    if len(digits) > 10:
        return "+" + digits
    return None


class SMSService:
    """Thin Twilio client with a `is_configured()` guard."""

    def __init__(self):
        self.account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
        self.auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
        self.from_number = os.environ.get("TWILIO_FROM_NUMBER", "").strip()
        self.messaging_service_sid = os.environ.get("TWILIO_MESSAGING_SERVICE_SID", "").strip()

    def is_configured(self) -> bool:
        return bool(self.account_sid and self.auth_token and (self.from_number or self.messaging_service_sid))

    def send_sms(self, to_phone: str, body: str) -> Tuple[bool, str]:
        """Send one text message. Returns (success, human-readable message)."""
        if not self.is_configured():
            return False, "SMS not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)"

        to = normalize_phone(to_phone)
        if not to:
            return False, f"Invalid phone number: {to_phone!r}"

        # Twilio limits a single segment to 160 chars; longer bodies are split
        # automatically but cost more, so keep our messages short.
        payload = {"To": to, "Body": body[:600]}
        if self.messaging_service_sid:
            payload["MessagingServiceSid"] = self.messaging_service_sid
        else:
            payload["From"] = self.from_number

        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"
        auth = base64.b64encode(f"{self.account_sid}:{self.auth_token}".encode()).decode()
        req = Request(
            url,
            data=urlencode(payload).encode(),
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return True, f"SMS sent (sid {data.get('sid', '?')})"
        except HTTPError as e:
            detail = e.read().decode("utf-8", "replace") if e.fp else str(e)
            return False, f"Twilio error {e.code}: {detail[:200]}"
        except URLError as e:
            return False, f"Twilio network error: {e.reason}"
        except Exception as e:  # pragma: no cover - defensive
            return False, f"SMS error: {e}"


_sms_service: Optional[SMSService] = None


def get_sms_service() -> SMSService:
    """Process-wide singleton (env vars do not change while running)."""
    global _sms_service
    if _sms_service is None:
        _sms_service = SMSService()
    return _sms_service
