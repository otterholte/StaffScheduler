"""
Small helpers shared by every route module.

Nothing here touches the database; these are pure functions plus a couple of
Flask-aware conveniences (site URL, JSON error responses).
"""

import re
from datetime import date, timedelta
from typing import Optional

from flask import current_app, jsonify, request

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DAY_NAMES_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# URL page slugs <-> internal tab ids used by the manager app
PAGE_SLUGS = {
    'schedule': 'schedule',
    'staff': 'employees',
    'availability': 'settings',
    'requirements': 'help',
}
TAB_TO_SLUG = {v: k for k, v in PAGE_SLUGS.items()}

# Path prefixes that must never be treated as a business slug
RESERVED_SLUGS = {'api', 'auth', 'employee', 'static', 'demo', 'settings', 'login', 'register',
                  'pricing', 'support', 'contact', 'features', 'app', 'favicon.ico', 'robots.txt'}


def slugify(text: str) -> str:
    """'Sunrise Coffee & Co.' -> 'sunrise-coffee-co' (URL-safe, lowercase)."""
    text = (text or '').lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text).strip('-')
    return text or 'business'


def site_url() -> str:
    """Base URL used in emails/SMS. Prefers SITE_URL so links are right behind proxies."""
    configured = current_app.config.get('SITE_URL')
    if configured and configured != 'http://localhost:5000':
        return configured.rstrip('/')
    try:
        return request.host_url.rstrip('/')
    except RuntimeError:
        return (configured or 'http://localhost:5000').rstrip('/')


def format_hour(hour: int) -> str:
    """9 -> '9am', 13 -> '1pm', 0/24 -> '12am'."""
    hour = int(hour) % 24
    if hour == 0:
        return '12am'
    if hour < 12:
        return f'{hour}am'
    if hour == 12:
        return '12pm'
    return f'{hour - 12}pm'


def format_shift_time(start_hour: int, end_hour: int) -> str:
    """(9, 17) -> '9am-5pm'."""
    return f'{format_hour(start_hour)}-{format_hour(end_hour)}'


def week_start_for_offset(offset: int = 0) -> date:
    """Monday of the current week plus `offset` weeks (server local date)."""
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    return monday + timedelta(weeks=int(offset or 0))


def parse_week_start(value: Optional[str], fallback_offset: int = 0) -> date:
    """Parse a 'YYYY-MM-DD' Monday sent by the browser; fall back to an offset.

    The browser sends its own local Monday so that users far from the server's
    timezone still see the week they expect.
    """
    if value:
        try:
            d = date.fromisoformat(value)
            return d - timedelta(days=d.weekday())  # snap to Monday just in case
        except ValueError:
            pass
    return week_start_for_offset(fallback_offset)


def json_error(message: str, status: int = 400, **extra):
    """Uniform JSON error body: {'success': False, 'message': ..., 'error': ...}."""
    payload = {'success': False, 'message': message, 'error': message}
    payload.update(extra)
    return jsonify(payload), status


def request_json() -> dict:
    """Request body as a dict, tolerating empty/non-JSON bodies."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def as_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
