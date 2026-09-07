"""
Employee portal API: my schedule, my availability, time off, shift swaps.

All endpoints require a login and `require_employee_access()` checks that the
caller either *is* the employee in the URL or owns the business. URLs use the
employee's integer database id.

ID conventions inherited from earlier versions (kept so existing data works):
    * ShiftSwapRequest.requester_employee_id stores the requester's DB id as a string.
    * SwapRequestRecipient.employee_id stores the recipient's model id (e.g. "emp_ab12cd34").
`_ids()` returns both forms for an employee so lookups can match either.
"""

import json
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from models import db, DBEmployee, DBSchedule, PTORequest, ShiftSwapRequest, SwapRequestRecipient
from scheduler.models import TimeSlot
from services.business_context import (
    BusinessAccessError, business_slug, require_coworker_access, require_employee_access,
)
from services.common import DAY_NAMES, as_int, format_shift_time, json_error, parse_week_start, request_json
from services.notifications import (
    contact_for, notify_counter_offer, notify_manager_swap_completed, notify_pto_submitted,
    notify_swap_created, notify_swap_response,
)
import db_service

employee_api_bp = Blueprint('employee_api', __name__)


@employee_api_bp.errorhandler(BusinessAccessError)
def _access_error(err):
    return json_error(str(err), err.status)


def _ids(db_employee: DBEmployee):
    """(model_id, db_id_as_string) for an employee row."""
    return db_employee.employee_id, str(db_employee.id)


def _db_employee_by_any_id(row, ref):
    """Find an employee row of a business by DB id (int/str) or model id."""
    if ref is None:
        return None
    try:
        emp = DBEmployee.query.get(int(ref))
        if emp and emp.business_db_id == row.id:
            return emp
    except (TypeError, ValueError):
        pass
    return DBEmployee.query.filter_by(business_db_id=row.id, employee_id=str(ref)).first()


def _dedupe_slots(slot_assignments):
    """One entry per employee per hour (older swap bugs could duplicate them)."""
    cleaned = {}
    for key, entries in slot_assignments.items():
        seen, out = set(), []
        for a in entries:
            emp_id = a.get('employee_id') if isinstance(a, dict) else (a[0] if a else None)
            if emp_id in seen:
                continue
            seen.add(emp_id)
            out.append(a)
        cleaned[key] = out
    return cleaned


# =============================================================================
# SCHEDULE
# =============================================================================

@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/schedule', methods=['GET'])
@login_required
def get_employee_schedule(business_ref, employee_id):
    business, row, db_employee = require_employee_access(employee_id)
    week_start = parse_week_start(request.args.get('weekStart'), request.args.get('weekOffset', 0, type=int))
    schedule = db_service.get_published_schedule_from_db(business.id, week_start)
    if not schedule:
        return jsonify({'success': False, 'published': False, 'week_start': week_start.isoformat(),
                        'message': 'No published schedule for this week'})
    model_id = db_employee.employee_id
    data = schedule.to_dict()
    return jsonify({
        'success': True,
        'published': True,
        'week_start': week_start.isoformat(),
        'schedule': {
            'assignments': data['assignments'],
            'slot_assignments': _dedupe_slots(data.get('slot_assignments', {})),
            'employee_shifts': [a for a in data['assignments'] if a['employee_id'] == model_id],
        },
    })


@employee_api_bp.route('/api/<business_ref>/pto/approved', methods=['GET'])
@login_required
def get_approved_pto_for_week(business_ref):
    """Approved time off overlapping a week (shown on both manager and employee schedules)."""
    business, row = require_coworker_access(business_ref)
    week_start = parse_week_start(request.args.get('weekStart'), request.args.get('weekOffset', 0, type=int))
    week_end = week_start + timedelta(days=6)
    approved = PTORequest.query.filter(
        PTORequest.business_db_id == row.id, PTORequest.status == 'approved',
        PTORequest.start_date <= week_end, PTORequest.end_date >= week_start,
    ).all()
    emps = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    result = []
    for req in approved:
        d = req.to_dict()
        emp = emps.get(req.employee_id)
        d['employee_name'] = emp.name if emp else 'Unknown'
        d['employee_color'] = emp.color if emp else '#888888'
        d['employee_db_id'] = emp.id if emp else None
        result.append(d)
    return jsonify({'success': True, 'week_start': week_start.isoformat(), 'week_end': week_end.isoformat(),
                    'approved_pto': result})


# =============================================================================
# AVAILABILITY + PREFERENCES
# =============================================================================

@employee_api_bp.route('/api/employee/<int:employee_id>/availability', methods=['PUT'])
@login_required
def employee_update_availability(employee_id):
    """Replace availability with 15-minute precision: {"availability": {"0": [[9, 17.5]], ...}}"""
    business, row, db_employee = require_employee_access(employee_id)
    employee = next((e for e in business.employees if e.id == db_employee.employee_id), None)
    if not employee:
        return json_error('Employee not found', 404)

    new_availability = request_json().get('availability', {})
    if not isinstance(new_availability, dict):
        return json_error('availability must be an object keyed by day')

    employee.clear_availability()
    for day_str, ranges in new_availability.items():
        day = as_int(day_str, -1)
        if not 0 <= day <= 6:
            continue
        for pair in ranges or []:
            try:
                start, end = float(pair[0]), float(pair[1])
            except (TypeError, ValueError, IndexError):
                continue
            if end > start:
                employee.add_availability(day, max(0.0, start), min(24.0, end))

    db_service.save_business_to_db(business, row.owner_id)
    out = {}
    for r in employee.availability_ranges:
        out.setdefault(r.day, []).append([r.start_time, r.end_time])
    return jsonify({'success': True, 'message': 'Availability updated', 'availability': out})


@employee_api_bp.route('/api/employee/<int:employee_id>/preferences', methods=['PUT'])
@login_required
def employee_update_preferences(employee_id):
    """Notification preferences and contact details the employee controls."""
    business, row, db_employee = require_employee_access(employee_id)
    data = request_json()
    if 'notify_email' in data:
        db_employee.notify_email = bool(data['notify_email'])
    if 'notify_sms' in data:
        db_employee.notify_sms = bool(data['notify_sms'])
    if 'phone' in data:
        db_employee.phone = (data.get('phone') or '').strip() or None
    db.session.commit()
    return jsonify({'success': True, 'message': 'Preferences saved',
                    'notify_email': bool(db_employee.notify_email), 'notify_sms': bool(db_employee.notify_sms),
                    'phone': db_employee.phone})


# =============================================================================
# TIME OFF
# =============================================================================

@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/pto', methods=['GET'])
@login_required
def get_employee_pto_requests(business_ref, employee_id):
    business, row, db_employee = require_employee_access(employee_id)
    requests_ = PTORequest.query.filter_by(business_db_id=row.id, employee_id=db_employee.employee_id) \
        .order_by(PTORequest.start_date.desc()).all()
    return jsonify({'success': True, 'pto_requests': [r.to_dict() for r in requests_]})


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/pto', methods=['POST'])
@login_required
def create_employee_pto_request(business_ref, employee_id):
    business, row, db_employee = require_employee_access(employee_id)
    data = request_json()
    try:
        start = date.fromisoformat(data.get('start_date') or '')
        end = date.fromisoformat(data.get('end_date') or data.get('start_date') or '')
    except ValueError:
        return json_error('Please choose valid dates.')
    if end < start:
        return json_error('End date cannot be before start date.')
    if start < date.today():
        return json_error('Time off cannot start in the past.')
    if (end - start).days > 90:
        return json_error('Requests are limited to 90 days at a time.')

    overlap = PTORequest.query.filter(
        PTORequest.business_db_id == row.id, PTORequest.employee_id == db_employee.employee_id,
        PTORequest.status.in_(['pending', 'approved']),
        PTORequest.start_date <= end, PTORequest.end_date >= start,
    ).first()
    if overlap:
        return json_error('You already have a request covering those dates.')

    pto_type = data.get('pto_type') if data.get('pto_type') in ('vacation', 'sick', 'personal', 'other') else 'vacation'
    pto = PTORequest(business_db_id=row.id, employee_id=db_employee.employee_id, start_date=start, end_date=end,
                     pto_type=pto_type, employee_note=(data.get('note') or '').strip()[:500] or None, status='pending')
    db.session.add(pto)
    db.session.commit()

    owner = row.owner
    if owner and owner.email:
        manager_contact = {'name': owner.first_name or owner.username, 'email': owner.email, 'phone': None,
                           'notify_email': True, 'notify_sms': False}
        notify_pto_submitted(manager_contact, business.name, business_slug(business.name), db_employee.name,
                             start, end, pto_type, pto.employee_note or '')

    return jsonify({'success': True, 'message': 'Time-off request sent to your manager.', 'pto_request': pto.to_dict()})


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/pto/<request_id>', methods=['DELETE'])
@login_required
def cancel_employee_pto_request(business_ref, employee_id, request_id):
    business, row, db_employee = require_employee_access(employee_id)
    pto = PTORequest.query.filter_by(request_id=request_id, business_db_id=row.id,
                                     employee_id=db_employee.employee_id).first()
    if not pto:
        return json_error('Request not found', 404)
    if pto.status != 'pending':
        return json_error('Only pending requests can be cancelled.')
    pto.status = 'cancelled'
    db.session.commit()
    return jsonify({'success': True, 'message': 'Request cancelled'})


# =============================================================================
# SHIFT SWAPS
# =============================================================================

def _employee_shifts_from_slots(slot_assignments, model_id):
    """Continuous shift blocks for one employee from a slot map (dict or tuple keys)."""
    by_day = {}
    for key, entries in slot_assignments.items():
        if isinstance(key, tuple):
            day, hour = key
        else:
            try:
                day, hour = [int(p) for p in str(key).split(',')[:2]]
            except ValueError:
                continue
        for a in entries:
            emp_id = a.get('employee_id') if isinstance(a, dict) else (a[0] if a else None)
            if emp_id == model_id:
                by_day.setdefault(day, []).append(hour)
    shifts = []
    for day, hours in by_day.items():
        hours = sorted(set(hours))
        start = prev = hours[0]
        for h in hours[1:]:
            if h != prev + 1:
                shifts.append({'day': day, 'start': start, 'end': prev + 1})
                start = h
            prev = h
        shifts.append({'day': day, 'start': start, 'end': prev + 1})
    return shifts


def eligible_employees_for_swap(business, requester_model_id, day, start_hour, end_hour, role_id, week_start):
    """Coworkers who could take a shift, and whether they can simply pick it up or must trade."""
    schedule = db_service.get_published_schedule_from_db(business.id, week_start)
    slots = schedule.slot_assignments if schedule else {}
    hours_by_emp = {}
    for entries in slots.values():
        for a in entries:
            emp_id = a.get('employee_id') if isinstance(a, dict) else (a[0] if a else None)
            hours_by_emp[emp_id] = hours_by_emp.get(emp_id, 0) + 1

    eligible = []
    for emp in business.employees:
        if emp.id == requester_model_id:
            continue
        if role_id and role_id not in emp.roles:
            continue
        if any(not emp.is_available(day, h) for h in range(start_hour, end_hour)):
            continue
        # Already working during that shift?
        busy = any(
            any((a.get('employee_id') if isinstance(a, dict) else a[0]) == emp.id for a in slots.get((day, h), []))
            for h in range(start_hour, end_hour)
        )
        if busy:
            continue
        current_hours = hours_by_emp.get(emp.id, 0)
        cap = emp.max_hours if emp.overtime_allowed else min(40, emp.max_hours)
        can_pickup = current_hours + (end_hour - start_hour) <= cap
        eligible.append({
            'employee_id': emp.id,
            'employee_name': emp.name,
            'employee_email': emp.email,
            'eligibility_type': 'pickup' if can_pickup else 'swap_only',
            'current_hours': current_hours,
            'current_shifts': _employee_shifts_from_slots(slots, emp.id),
            'would_exceed_hours': not can_pickup,
        })
    return eligible


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/eligible-for-swap', methods=['GET'])
@login_required
def get_eligible_for_swap(business_ref, employee_id):
    business, row, db_employee = require_employee_access(employee_id)
    day = request.args.get('day', type=int)
    start_hour = request.args.get('start_hour', type=int)
    end_hour = request.args.get('end_hour', type=int)
    week_start = parse_week_start(request.args.get('week_start'))
    if day is None or start_hour is None or end_hour is None:
        return json_error('Missing shift details')
    eligible = eligible_employees_for_swap(business, db_employee.employee_id, day, start_hour, end_hour,
                                          request.args.get('role_id'), week_start)
    return jsonify({'success': True, 'eligible': eligible, 'total_count': len(eligible),
                    'pickup_count': sum(1 for e in eligible if e['eligibility_type'] == 'pickup'),
                    'swap_only_count': sum(1 for e in eligible if e['eligibility_type'] == 'swap_only')})


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/swap-requests', methods=['GET'])
@login_required
def get_swap_requests(business_ref, employee_id):
    """Outgoing (mine) and incoming (I was asked) swap requests."""
    business, row, db_employee = require_employee_access(employee_id)
    model_id, db_id_str = _ids(db_employee)
    names = {e.id: e.name for e in business.employees}
    db_rows = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}

    outgoing = ShiftSwapRequest.query.filter(
        ShiftSwapRequest.business_db_id == row.id,
        ShiftSwapRequest.requester_employee_id.in_([db_id_str, model_id]),
    ).order_by(ShiftSwapRequest.created_at.desc()).limit(50).all()

    outgoing_data = []
    for req in outgoing:
        d = req.to_dict()
        d['recipients'] = [{**r.to_dict(), 'employee_name': names.get(r.employee_id, 'Unknown')} for r in req.recipients]
        outgoing_data.append(d)

    incoming = []
    recipient_rows = SwapRequestRecipient.query.filter(
        SwapRequestRecipient.employee_id.in_([model_id, db_id_str])
    ).all()
    for recipient in recipient_rows:
        swap = recipient.swap_request
        if swap.business_db_id != row.id or swap.status != 'pending':
            continue
        requester = _db_employee_by_any_id(row, swap.requester_employee_id)
        entry = {**swap.to_dict(), 'requester_name': requester.name if requester else 'Unknown',
                 'requester_db_id': requester.id if requester else None,
                 'my_response': recipient.response, 'my_eligibility_type': recipient.eligibility_type}
        if swap.is_counter_offer and swap.counter_offer_for_id:
            original = ShiftSwapRequest.query.get(swap.counter_offer_for_id)
            if original:
                entry.update({
                    'original_request_day': original.original_day,
                    'original_request_start_hour': original.original_start_hour,
                    'original_request_end_hour': original.original_end_hour,
                    'original_request_week_start_date': original.week_start_date.isoformat() if original.week_start_date else None,
                })
        incoming.append(entry)
    incoming.sort(key=lambda e: e.get('created_at') or '', reverse=True)
    return jsonify({'success': True, 'outgoing': outgoing_data, 'incoming': incoming})


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/swap-request', methods=['POST'])
@login_required
def create_swap_request(business_ref, employee_id):
    business, row, db_employee = require_employee_access(employee_id)
    model_id, db_id_str = _ids(db_employee)
    data = request_json()

    day, start_hour, end_hour = data.get('day'), data.get('start_hour'), data.get('end_hour')
    if day is None or start_hour is None or end_hour is None or not data.get('week_start'):
        return json_error('Missing shift details')
    day, start_hour, end_hour = as_int(day, -1), as_int(start_hour, -1), as_int(end_hour, -1)
    if not (0 <= day <= 6) or end_hour <= start_hour:
        return json_error('Invalid shift')
    week_start = parse_week_start(data.get('week_start'))

    # The requester must actually hold this shift on the published schedule
    schedule = db_service.get_published_schedule_from_db(business.id, week_start)
    if not schedule:
        return json_error('There is no published schedule for that week yet.')
    holds = all(any((a[0] == model_id) for a in schedule.slot_assignments.get((day, h), []))
                for h in range(start_hour, end_hour))
    if not holds:
        return json_error("That shift isn't on your schedule anymore. Refresh and try again.")

    duplicate = ShiftSwapRequest.query.filter_by(
        business_db_id=row.id, requester_employee_id=db_id_str, original_day=day,
        original_start_hour=start_hour, original_end_hour=end_hour, week_start_date=week_start, status='pending',
    ).first()
    if duplicate:
        return json_error('You already have an open request for this shift.')

    role_id = data.get('role_id')
    note = (data.get('note') or '').strip()[:500]
    swap = ShiftSwapRequest(
        business_db_id=row.id, requester_employee_id=db_id_str, original_day=day,
        original_start_hour=start_hour, original_end_hour=end_hour, original_role_id=role_id,
        week_start_date=week_start, note=note or None, open_for_swaps=bool(data.get('open_for_swaps')),
        status='pending', expires_at=datetime.utcnow() + timedelta(hours=72),
    )
    db.session.add(swap)
    db.session.flush()

    eligible = eligible_employees_for_swap(business, model_id, day, start_hour, end_hour, role_id, week_start)
    wanted = set(data.get('recipients') or [])
    if wanted:
        eligible = [e for e in eligible if e['employee_id'] in wanted]
    if not eligible:
        db.session.rollback()
        return json_error('Nobody is eligible to take this shift right now (role, availability, or hours).', 400)

    db_rows = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    notify_list = []
    for e in eligible:
        db.session.add(SwapRequestRecipient(swap_request_id=swap.id, employee_id=e['employee_id'],
                                            eligibility_type=e['eligibility_type'], response='pending',
                                            notified_at=datetime.utcnow()))
        db_row = db_rows.get(e['employee_id'])
        if db_row and (db_row.email or db_row.phone):
            notify_list.append({'contact': contact_for(db_row), 'employee_db_id': db_row.id,
                                'eligibility_type': e['eligibility_type']})
    db.session.commit()

    if notify_list:
        notify_swap_created(business.name, business_slug(business.name), db_employee.name,
                            day, start_hour, end_hour, week_start, notify_list, note)

    return jsonify({'success': True, 'swap_request': swap.to_dict(), 'eligible_count': len(eligible),
                    'notifications_sent': len(notify_list),
                    'message': f'Request sent to {len(eligible)} coworker(s).'})


def _find_recipient(swap: ShiftSwapRequest, db_employee: DBEmployee):
    model_id, db_id_str = _ids(db_employee)
    return SwapRequestRecipient.query.filter(
        SwapRequestRecipient.swap_request_id == swap.id,
        SwapRequestRecipient.employee_id.in_([model_id, db_id_str]),
    ).first()


def _replace_in_slots(slots: dict, day: int, start_hour: int, end_hour: int, remove_id: str,
                      add_id: str, role_id: str, business, via_swap: bool):
    """Move a shift from one employee to another inside the JSON slot map."""
    name, color = None, None
    for emp in business.employees:
        if emp.id == add_id:
            name, color = emp.name, emp.color
            break
    for hour in range(start_hour, end_hour):
        key = f"{day},{hour}"
        entries = slots.get(key, [])
        kept = [a for a in entries
                if (a.get('employee_id') if isinstance(a, dict) else a[0]) not in (remove_id, add_id)]
        entry = {'employee_id': add_id, 'role_id': role_id}
        if name:
            entry['employee_name'], entry['color'] = name, color
        if via_swap:
            entry['via_swap'], entry['swapped_from'] = True, remove_id
        kept.append(entry)
        slots[key] = kept


def _apply_swap_to_schedule(business, row, swap: ShiftSwapRequest, requester_model_id: str,
                            accepter_model_id: str, swap_shift):
    """Update the published schedule JSON and shift rows. Returns error string or None."""
    rec = db_service.get_schedule_record(business.id, swap.week_start_date, published_only=True)
    if not rec:
        return 'No published schedule found for that week.'
    data = rec.get_schedule_data()
    slots = data.get('slot_assignments', {})

    _replace_in_slots(slots, swap.original_day, swap.original_start_hour, swap.original_end_hour,
                      requester_model_id, accepter_model_id, swap.original_role_id or 'staff', business, True)
    if swap_shift:
        _replace_in_slots(slots, swap_shift['day'], swap_shift['start_hour'], swap_shift['end_hour'],
                          accepter_model_id, requester_model_id, swap_shift.get('role_id') or 'staff', business, True)
    data['slot_assignments'] = slots

    # Keep the assignment list in sync too (used by employee schedule + publish emails)
    def move(assignments, day, s, e, from_id, to_id, role):
        out = [a for a in assignments if not (a.get('employee_id') in (from_id, to_id) and a.get('day') == day
                                              and not (a.get('end_hour') <= s or a.get('start_hour') >= e))]
        emp = next((x for x in business.employees if x.id == to_id), None)
        role_obj = next((r for r in business.roles if r.id == role), None)
        out.append({'employee_id': to_id, 'employee_name': emp.name if emp else to_id, 'day': day,
                    'start_hour': s, 'end_hour': e, 'duration': e - s, 'role_id': role,
                    'color': role_obj.color if role_obj else (emp.color if emp else '#4CAF50')})
        return out

    assignments = data.get('assignments', [])
    assignments = move(assignments, swap.original_day, swap.original_start_hour, swap.original_end_hour,
                       requester_model_id, accepter_model_id, swap.original_role_id or 'staff')
    if swap_shift:
        assignments = move(assignments, swap_shift['day'], swap_shift['start_hour'], swap_shift['end_hour'],
                           accepter_model_id, requester_model_id, swap_shift.get('role_id') or 'staff')
    data['assignments'] = assignments
    rec.set_schedule_data(data)

    # Rebuild the per-shift rows from the assignment list
    from models import DBShiftAssignment
    DBShiftAssignment.query.filter_by(schedule_id=rec.id).delete()
    for a in assignments:
        db.session.add(DBShiftAssignment(schedule_id=rec.id, employee_id=a['employee_id'],
                                         employee_name=a.get('employee_name', ''), day=a['day'],
                                         start_hour=a['start_hour'], end_hour=a['end_hour'],
                                         role_id=a.get('role_id', ''), color=a.get('color', '#4CAF50')))
    return None


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/swap-request/<request_id>/respond', methods=['POST'])
@login_required
def respond_to_swap_request(business_ref, employee_id, request_id):
    """accept | decline | counter_offer."""
    business, row, db_employee = require_employee_access(employee_id)
    model_id, db_id_str = _ids(db_employee)
    data = request_json()
    response = data.get('response')
    swap_shift = data.get('swap_shift')
    if response not in ('accept', 'decline', 'counter_offer'):
        return json_error('Invalid response')

    swap = ShiftSwapRequest.query.filter_by(request_id=request_id, business_db_id=row.id).first()
    if not swap:
        return json_error('Swap request not found', 404)
    if swap.status != 'pending':
        return json_error(f'This request is already {swap.status}.')
    recipient = _find_recipient(swap, db_employee)
    if not recipient:
        return json_error('You were not asked to cover this shift.', 403)

    requester = _db_employee_by_any_id(row, swap.requester_employee_id)
    requester_model_id = requester.employee_id if requester else swap.requester_employee_id
    slug = business_slug(business.name)

    # ---- counter offer: a new request in the other direction ----------------
    if response == 'counter_offer':
        if not swap_shift:
            return json_error('Choose one of your shifts to offer.')
        recipient.response = 'counter_offered'
        recipient.responded_at = datetime.utcnow()
        counter = ShiftSwapRequest(
            business_db_id=row.id, requester_employee_id=db_id_str,
            original_day=as_int(swap_shift.get('day'), 0), original_start_hour=as_int(swap_shift.get('start_hour'), 0),
            original_end_hour=as_int(swap_shift.get('end_hour'), 0), original_role_id=swap_shift.get('role_id'),
            week_start_date=swap.week_start_date, status='pending', is_counter_offer=True, counter_offer_for_id=swap.id,
            note=f"Trade offer for your {DAY_NAMES[swap.original_day]} {format_shift_time(swap.original_start_hour, swap.original_end_hour)} shift",
            expires_at=datetime.utcnow() + timedelta(hours=72),
        )
        db.session.add(counter)
        db.session.flush()
        db.session.add(SwapRequestRecipient(swap_request_id=counter.id, employee_id=requester_model_id,
                                            eligibility_type='swap_only', notified_at=datetime.utcnow()))
        db.session.commit()
        if requester and (requester.email or requester.phone):
            notify_counter_offer(business.name, slug, contact_for(requester), requester.id, db_employee.name,
                                 offered={'day': counter.original_day, 'start_hour': counter.original_start_hour,
                                          'end_hour': counter.original_end_hour},
                                 wanted={'day': swap.original_day, 'start_hour': swap.original_start_hour,
                                         'end_hour': swap.original_end_hour},
                                 week_start=swap.week_start_date)
        return jsonify({'success': True, 'message': 'Trade offer sent.', 'counter_offer_id': counter.request_id})

    # ---- decline -------------------------------------------------------------
    if response == 'decline':
        recipient.response = 'declined'
        recipient.responded_at = datetime.utcnow()
        if all(r.response == 'declined' for r in swap.recipients):
            swap.status = 'declined'
            swap.resolved_at = datetime.utcnow()
        db.session.commit()
        if requester and (requester.email or requester.phone):
            notify_swap_response(business.name, slug, contact_for(requester), requester.id, db_employee.name,
                                 swap.original_day, swap.original_start_hour, swap.original_end_hour,
                                 swap.week_start_date, accepted=False)
        return jsonify({'success': True, 'message': 'Declined.'})

    # ---- accept --------------------------------------------------------------
    if recipient.eligibility_type == 'swap_only' and not swap_shift and not swap.is_counter_offer:
        return json_error('Picking this up would exceed your max hours. Offer one of your shifts in exchange.')

    if swap.is_counter_offer and not swap_shift and swap.counter_offer_for_id:
        original = ShiftSwapRequest.query.get(swap.counter_offer_for_id)
        if original:
            swap_shift = {'day': original.original_day, 'start_hour': original.original_start_hour,
                          'end_hour': original.original_end_hour, 'role_id': original.original_role_id}
            original.status = 'accepted'
            original.resolved_at = datetime.utcnow()
            original.accepted_by_employee_id = swap.requester_employee_id

    if swap_shift:
        try:
            swap_shift = {'day': int(swap_shift['day']), 'start_hour': int(swap_shift['start_hour']),
                          'end_hour': int(swap_shift['end_hour']), 'role_id': swap_shift.get('role_id')}
        except (KeyError, TypeError, ValueError):
            return json_error('Invalid shift offered.')

    error = _apply_swap_to_schedule(business, row, swap, requester_model_id, model_id, swap_shift)
    if error:
        db.session.rollback()
        return json_error(f'Could not update the schedule: {error}', 500)

    swap.status = 'accepted'
    swap.accepted_by_employee_id = db_id_str
    swap.resolved_at = datetime.utcnow()
    if swap_shift:
        swap.swap_day, swap.swap_start_hour = swap_shift['day'], swap_shift['start_hour']
        swap.swap_end_hour, swap.swap_role_id = swap_shift['end_hour'], swap_shift.get('role_id')
    recipient.response = 'accepted'
    recipient.responded_at = datetime.utcnow()
    db.session.commit()

    if requester and (requester.email or requester.phone):
        notify_swap_response(business.name, slug, contact_for(requester), requester.id, db_employee.name,
                             swap.original_day, swap.original_start_hour, swap.original_end_hour,
                             swap.week_start_date, accepted=True, swap_shift=swap_shift)
    owner = row.owner
    if owner and owner.email:
        notify_manager_swap_completed({'name': owner.first_name or owner.username, 'email': owner.email,
                                       'notify_email': True, 'notify_sms': False},
                                      business.name, slug, requester.name if requester else 'Unknown',
                                      db_employee.name, swap.original_day, swap.original_start_hour,
                                      swap.original_end_hour, swap.week_start_date, swap_shift)

    return jsonify({'success': True, 'message': 'Done! The schedule has been updated.', 'swap_request': swap.to_dict()})


@employee_api_bp.route('/api/employee/<business_ref>/<int:employee_id>/swap-request/<request_id>/cancel', methods=['POST'])
@login_required
def cancel_swap_request(business_ref, employee_id, request_id):
    business, row, db_employee = require_employee_access(employee_id)
    model_id, db_id_str = _ids(db_employee)
    swap = ShiftSwapRequest.query.filter_by(request_id=request_id, business_db_id=row.id).first()
    if not swap:
        return json_error('Swap request not found', 404)
    if swap.requester_employee_id not in (db_id_str, model_id):
        return json_error('Only the person who made the request can cancel it.', 403)
    if swap.status != 'pending':
        return json_error(f'This request is already {swap.status}.')
    swap.status = 'cancelled'
    swap.resolved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({'success': True, 'message': 'Request cancelled'})
