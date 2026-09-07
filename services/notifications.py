"""
Outbound notifications (email + SMS) for the events staff care about.

Every public `notify_*` function gathers plain data while the request is
still open, then does the actual sending on a daemon thread so the HTTP
response is never delayed by a slow mail or SMS provider.

Channel rules:
    * Email goes out when the employee has an address and `notify_email` is on.
    * SMS goes out when the employee has a phone number, `notify_sms` is on,
      and Twilio is configured (see sms_service.py). Otherwise it is skipped
      silently, so the app works fine without Twilio.
"""

import threading
import traceback
from datetime import date
from typing import Iterable, List, Optional

from flask import current_app

from email_service import get_email_service
from sms_service import get_sms_service
from services.common import DAY_NAMES, format_shift_time, site_url


# ---------------------------------------------------------------- plumbing

def _run_in_background(app, fn, *args, **kwargs):
    """Run `fn` inside an app context on a daemon thread; log any failure."""

    def target():
        with app.app_context():
            try:
                fn(*args, **kwargs)
            except Exception:
                traceback.print_exc()

    threading.Thread(target=target, daemon=True, name=f"notify-{fn.__name__}").start()


def _app():
    return current_app._get_current_object()


def _deliver(contact: dict, subject: str, title: str, greeting: str, intro: str,
             detail_lines: Optional[List[str]] = None, cta_text: Optional[str] = None,
             cta_url: Optional[str] = None, sms_text: Optional[str] = None,
             accent=("#467df6", "#a855f7"), footer_note: str = ""):
    """Send one message over every channel the contact has enabled."""
    email = contact.get('email')
    phone = contact.get('phone')
    sent = []
    if email and contact.get('notify_email', True):
        svc = get_email_service()
        if svc.is_configured():
            ok, msg = svc.send_notification(
                to_email=email, subject=subject, title=title, greeting=greeting, intro=intro,
                detail_lines=detail_lines, cta_text=cta_text, cta_url=cta_url,
                accent_start=accent[0], accent_end=accent[1], footer_note=footer_note,
            )
            sent.append(('email', ok, msg))
    if phone and contact.get('notify_sms', True) and sms_text:
        sms = get_sms_service()
        if sms.is_configured():
            ok, msg = sms.send_sms(phone, sms_text)
            sent.append(('sms', ok, msg))
    for channel, ok, msg in sent:
        print(f"[NOTIFY] {channel} to {email if channel == 'email' else phone}: {'ok' if ok else 'FAILED'} - {msg}", flush=True)
    return sent


def contact_for(emp) -> dict:
    """Contact dict from either an Employee dataclass or a DBEmployee row."""
    return {
        'name': getattr(emp, 'name', ''),
        'email': (getattr(emp, 'email', None) or '').strip() or None,
        'phone': (getattr(emp, 'phone', None) or '').strip() or None,
        'notify_email': getattr(emp, 'notify_email', True) if getattr(emp, 'notify_email', None) is not None else True,
        'notify_sms': getattr(emp, 'notify_sms', True) if getattr(emp, 'notify_sms', None) is not None else True,
    }


def _shift_text(day: int, start_hour: int, end_hour: int, week_start: Optional[date] = None) -> str:
    """'Tuesday, Sep 8 9am-5pm' (date included when the week is known)."""
    label = DAY_NAMES[day]
    if week_start:
        from datetime import timedelta
        d = week_start + timedelta(days=day)
        label = f"{DAY_NAMES[day]}, {d.strftime('%b')} {d.day}"
    return f"{label} {format_shift_time(start_hour, end_hour)}"


def _date_range_text(start: date, end: date) -> str:
    if start == end:
        return start.strftime('%A, %b %d')
    return f"{start.strftime('%b %d')} - {end.strftime('%b %d')}"


# ---------------------------------------------------------------- swaps

def notify_swap_created(business_name: str, business_slug: str, requester_name: str,
                        day: int, start_hour: int, end_hour: int, week_start: date,
                        recipients: Iterable[dict], note: str = ''):
    """Tell every eligible coworker a shift is up for grabs.

    `recipients` items: {contact: {...}, employee_db_id, eligibility_type}
    """
    base = site_url()
    shift = _shift_text(day, start_hour, end_hour, week_start)
    tasks = [dict(r) for r in recipients]

    def send():
        for r in tasks:
            portal = f"{base}/employee/{business_slug}/{r['employee_db_id']}/schedule"
            action = 'pick it up' if r.get('eligibility_type') == 'pickup' else 'trade one of your shifts for it'
            first = (r['contact'].get('name') or 'there').split()[0]
            _deliver(
                r['contact'],
                subject=f"Shift available: {shift} at {business_name}",
                title="🔄 Shift Available",
                greeting=f"Hi {first}!",
                intro=f"<strong>{requester_name}</strong> needs someone to cover a shift at <strong>{business_name}</strong>. You can {action}.",
                detail_lines=[f"📅 {shift}"] + ([f"Note: {note}"] if note else []),
                cta_text="Respond in the app", cta_url=portal,
                sms_text=f"{business_name}: {requester_name} needs {shift} covered. You can {action}. Respond: {portal}",
                accent=("#f59e0b", "#ef4444"),
            )

    _run_in_background(_app(), send)


def notify_swap_response(business_name: str, business_slug: str, requester_contact: dict,
                         requester_db_id: int, responder_name: str, day: int, start_hour: int,
                         end_hour: int, week_start: date, accepted: bool,
                         swap_shift: Optional[dict] = None):
    """Tell the requester their shift was taken (or declined)."""
    base = site_url()
    shift = _shift_text(day, start_hour, end_hour, week_start)
    portal = f"{base}/employee/{business_slug}/{requester_db_id}/schedule"
    first = (requester_contact.get('name') or 'there').split()[0]
    if accepted:
        lines = [f"📅 {shift} → now covered by {responder_name}"]
        if swap_shift:
            lines.append(f"🔄 In return you take: {_shift_text(swap_shift['day'], swap_shift['start_hour'], swap_shift['end_hour'], week_start)}")
        kwargs = dict(
            subject=f"{responder_name} took your {shift} shift",
            title="✅ Shift Covered", greeting=f"Great news, {first}!",
            intro=f"<strong>{responder_name}</strong> accepted your request at <strong>{business_name}</strong>. The schedule has been updated.",
            detail_lines=lines, cta_text="View updated schedule", cta_url=portal,
            sms_text=f"{business_name}: {responder_name} took your {shift} shift. Schedule updated: {portal}",
            accent=("#10b981", "#059669"),
        )
    else:
        kwargs = dict(
            subject=f"{responder_name} declined your {shift} swap",
            title="Swap Declined", greeting=f"Hi {first},",
            intro=f"<strong>{responder_name}</strong> can't cover your shift at <strong>{business_name}</strong>. Your request is still open to anyone else who was notified.",
            detail_lines=[f"📅 {shift}"], cta_text="View request", cta_url=portal,
            sms_text=f"{business_name}: {responder_name} declined your {shift} swap. Still open to others: {portal}",
            accent=("#ef4444", "#dc2626"),
        )

    _run_in_background(_app(), _deliver, requester_contact, **kwargs)


def notify_counter_offer(business_name: str, business_slug: str, to_contact: dict, to_db_id: int,
                         from_name: str, offered: dict, wanted: dict, week_start: date):
    """Someone wants to trade instead of simply covering."""
    base = site_url()
    portal = f"{base}/employee/{business_slug}/{to_db_id}/schedule"
    offered_txt = _shift_text(offered['day'], offered['start_hour'], offered['end_hour'], week_start)
    wanted_txt = _shift_text(wanted['day'], wanted['start_hour'], wanted['end_hour'], week_start)
    first = (to_contact.get('name') or 'there').split()[0]
    _run_in_background(
        _app(), _deliver, to_contact,
        subject=f"{from_name} offered a trade for your {wanted_txt} shift",
        title="🔁 Trade Offer", greeting=f"Hi {first}!",
        intro=f"<strong>{from_name}</strong> will take your shift at <strong>{business_name}</strong> if you take theirs in return.",
        detail_lines=[f"Their shift for you: {offered_txt}", f"Your shift they'd take: {wanted_txt}"],
        cta_text="Accept or decline", cta_url=portal,
        sms_text=f"{business_name}: {from_name} offers to swap their {offered_txt} for your {wanted_txt}. Respond: {portal}",
        accent=("#0ea5e9", "#6366f1"),
    )


def notify_manager_swap_completed(manager_contact: dict, business_name: str, business_slug: str,
                                  requester_name: str, accepter_name: str, day: int, start_hour: int,
                                  end_hour: int, week_start: date, swap_shift: Optional[dict] = None):
    base = site_url()
    shift = _shift_text(day, start_hour, end_hour, week_start)
    lines = [f"📅 {shift}: {requester_name} → {accepter_name}"]
    if swap_shift:
        lines.append(f"🔄 {accepter_name} handed {requester_name}: {_shift_text(swap_shift['day'], swap_shift['start_hour'], swap_shift['end_hour'], week_start)}")
    _run_in_background(
        _app(), _deliver, manager_contact,
        subject=f"Shift swap completed: {requester_name} ↔ {accepter_name}",
        title="📋 Swap Completed", greeting=f"Hi {(manager_contact.get('name') or 'there').split()[0]},",
        intro=f"A shift swap at <strong>{business_name}</strong> was completed and the published schedule has been updated automatically. No action needed.",
        detail_lines=lines, cta_text="View schedule", cta_url=f"{base}/{business_slug}/schedule",
        sms_text=None, accent=("#8b5cf6", "#6366f1"),
    )


# ---------------------------------------------------------------- time off

def notify_pto_submitted(manager_contact: dict, business_name: str, business_slug: str,
                         employee_name: str, start: date, end: date, pto_type: str, note: str = ''):
    base = site_url()
    when = _date_range_text(start, end)
    _run_in_background(
        _app(), _deliver, manager_contact,
        subject=f"Time-off request from {employee_name} ({when})",
        title="🗓️ Time-Off Request", greeting=f"Hi {(manager_contact.get('name') or 'there').split()[0]},",
        intro=f"<strong>{employee_name}</strong> requested time off at <strong>{business_name}</strong>.",
        detail_lines=[f"📅 {when}", f"Type: {pto_type.title()}"] + ([f"Note: {note}"] if note else []),
        cta_text="Review request", cta_url=f"{base}/{business_slug}/staff",
        sms_text=f"{business_name}: {employee_name} requested time off {when}. Review: {base}/{business_slug}/staff",
        accent=("#f59e0b", "#f97316"),
    )


def notify_pto_decision(employee_contact: dict, employee_db_id: int, business_name: str, business_slug: str,
                        approved: bool, start: date, end: date, manager_note: str = '', shifts_removed: int = 0):
    base = site_url()
    when = _date_range_text(start, end)
    portal = f"{base}/employee/{business_slug}/{employee_db_id}/availability"
    first = (employee_contact.get('name') or 'there').split()[0]
    if approved:
        lines = [f"📅 {when} — approved"]
        if shifts_removed:
            lines.append(f"{shifts_removed} scheduled shift(s) on those days were removed for you.")
        kwargs = dict(
            subject=f"Time off approved: {when}", title="✅ Time Off Approved", greeting=f"Hi {first}!",
            intro=f"Your time-off request at <strong>{business_name}</strong> was approved.",
            detail_lines=lines + ([f"Manager note: {manager_note}"] if manager_note else []),
            cta_text="View your requests", cta_url=portal,
            sms_text=f"{business_name}: your time off {when} was approved.",
            accent=("#10b981", "#059669"),
        )
    else:
        kwargs = dict(
            subject=f"Time off not approved: {when}", title="Time Off Declined", greeting=f"Hi {first},",
            intro=f"Your time-off request at <strong>{business_name}</strong> was not approved.",
            detail_lines=[f"📅 {when}"] + ([f"Manager note: {manager_note}"] if manager_note else []),
            cta_text="View your requests", cta_url=portal,
            sms_text=f"{business_name}: your time off request for {when} was declined." + (f" Note: {manager_note}" if manager_note else ''),
            accent=("#ef4444", "#dc2626"),
        )
    _run_in_background(_app(), _deliver, employee_contact, **kwargs)


# ---------------------------------------------------------------- schedule

def notify_schedule_published(business_name: str, business_slug: str, week_start: date,
                              employees: Iterable[dict]):
    """Let everyone know a new week is live. `employees`: {contact, employee_db_id, shifts:[str]}"""
    base = site_url()
    from datetime import timedelta
    week_txt = f"{week_start.strftime('%b %d')} - {(week_start + timedelta(days=6)).strftime('%b %d')}"
    tasks = [dict(e) for e in employees]

    def send():
        for e in tasks:
            portal = f"{base}/employee/{business_slug}/{e['employee_db_id']}/schedule"
            shifts = e.get('shifts') or []
            first = (e['contact'].get('name') or 'there').split()[0]
            lines = shifts if shifts else ["You have no shifts this week."]
            summary = f"{len(shifts)} shift(s)" if shifts else "no shifts"
            _deliver(
                e['contact'],
                subject=f"Your schedule for {week_txt} at {business_name}",
                title="📅 New Schedule Published", greeting=f"Hi {first}!",
                intro=f"The schedule for <strong>{week_txt}</strong> at <strong>{business_name}</strong> is now published. You have {summary}.",
                detail_lines=lines, cta_text="View my schedule", cta_url=portal,
                sms_text=f"{business_name}: schedule for {week_txt} is published. You have {summary}. {portal}",
                accent=("#467df6", "#a855f7"),
                footer_note="You can turn these notifications off in your portal settings.",
            )

    _run_in_background(_app(), send)


# ---------------------------------------------------------------- invitations

def send_invitation_now(employee_contact: dict, business_name: str, portal_url: str,
                        login_url: str, temp_password: Optional[str]):
    """Synchronous invitation (the manager waits to see if it worked)."""
    results = []
    email = employee_contact.get('email')
    if email:
        svc = get_email_service()
        if svc.is_configured():
            ok, msg = svc.send_portal_invitation(
                to_email=email, employee_name=employee_contact.get('name') or 'there',
                business_name=business_name, portal_url=portal_url, login_url=login_url,
                temp_password=temp_password,
            )
            results.append(('email', ok, msg))
        else:
            results.append(('email', False, 'Email service not configured'))
    phone = employee_contact.get('phone')
    if phone:
        sms = get_sms_service()
        if sms.is_configured():
            text = f"{business_name} invited you to Staff Scheduler. Log in at {login_url} with {email or 'your email'}"
            if temp_password:
                text += f" and temporary password {temp_password}"
            ok, msg = sms.send_sms(phone, text + ".")
            results.append(('sms', ok, msg))
        else:
            results.append(('sms', False, 'SMS not configured'))
    return results
