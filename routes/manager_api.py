"""
Manager API: businesses, staff, roles, coverage requirements, settings, time-off review.

Every endpoint resolves its business through `require_business()`, which
loads a fresh copy from the database for the logged-in owner (or the shared
in-memory demo business on the demo page). After a change we call `persist()`
so the database is always the source of truth.

The browser identifies the business with `businessId` (JSON body or query
string) or with a `<business_ref>` path segment that may be either the
business id or its URL slug. When neither is present, the business the user
last opened (kept in the session) is used.
"""

import re
import secrets
import uuid
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from models import db, DBEmployee, DBSchedule, DBShiftAssignment, PTORequest, User, BusinessSettings, UserBusinessSettings
from scheduler import DAYS_OF_WEEK
from scheduler.models import (
    CoverageMode, Employee, EmployeeClassification, PeakPeriod, Role, RoleCoverageConfig,
    ShiftRoleRequirement, ShiftTemplate, TimeSlot,
)
from email_service import get_email_service
from sms_service import get_sms_service
from services.business_context import (
    BusinessAccessError, business_slug, create_business_for_user, db_summary, is_demo_id,
    list_owned_businesses, persist, require_business, set_current_business_id, summary,
    user_owns,
)
from services.common import as_float, as_int, json_error, parse_week_start, request_json, site_url
from services.notifications import contact_for, notify_pto_decision, send_invitation_now
import db_service

manager_api_bp = Blueprint('manager_api', __name__)


@manager_api_bp.errorhandler(BusinessAccessError)
def _access_error(err):
    return json_error(str(err), err.status)


def _business_ref(data: dict = None) -> str:
    """businessId from the JSON body, else the query string."""
    data = data if data is not None else request_json()
    return data.get('businessId') or data.get('business_id') or request.args.get('businessId') or request.args.get('business_id')


def _find_employee(business, emp_id: str):
    return next((e for e in business.employees if e.id == emp_id), None)


def _attach_db_ids(business):
    """Fill in `db_id` on each Employee so the UI can build portal links."""
    if is_demo_id(business.id):
        return
    row = db_service.get_db_business(business.id)
    if not row:
        return
    ids = {e.employee_id: e.id for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    for emp in business.employees:
        emp.db_id = ids.get(emp.id)


# =============================================================================
# BUSINESSES (locations)
# =============================================================================

@manager_api_bp.route('/api/businesses', methods=['GET'])
def list_businesses():
    """Only the caller's own businesses. Demo businesses are listed on the demo page."""
    if not current_user.is_authenticated:
        from scheduler import list_demo_businesses
        return jsonify({'businesses': [summary(b) for b in list_demo_businesses()]})
    return jsonify({'businesses': [db_summary(b) for b in list_owned_businesses()]})


@manager_api_bp.route('/api/business/<business_ref>', methods=['POST'])
def switch_business(business_ref):
    """Make a business the current one and return its full data."""
    business = require_business(business_ref)
    set_current_business_id(business.id)
    _attach_db_ids(business)
    payload = business.to_dict()
    payload['slug'] = business_slug(business.name)
    return jsonify({'success': True, 'business': payload, 'slug': payload['slug'],
                    'message': f'Switched to {business.name}'})


@manager_api_bp.route('/api/business/save', methods=['POST'])
@login_required
def save_business():
    """Create a new location (no id) or rename/recolor an existing one."""
    data = request_json()
    name = (data.get('name') or '').strip()
    emoji = (data.get('emoji') or '🏢').strip()[:10]
    color = (data.get('color') or '#6366f1').strip()[:20]
    if not name:
        return json_error('Name is required')

    business_id = data.get('id')
    if business_id:
        if is_demo_id(business_id):
            return json_error('Demo businesses cannot be renamed. Create your own location instead.', 400)
        row = db_service.get_db_business(business_id)
        if not row or not user_owns(row):
            return json_error('Business not found', 404)
        # Keep slugs unique among this user's businesses
        for other in list_owned_businesses():
            if other.id != row.id and business_slug(other.name) == business_slug(name):
                return json_error('You already have a location with that name.', 400)
        db_service.update_business_metadata(business_id, name=name, emoji=emoji, color=color)
        return jsonify({'success': True, 'business_id': business_id, 'slug': business_slug(name),
                        'message': 'Location updated'})

    owner_name = f"{current_user.first_name or ''} {current_user.last_name or ''}".strip() or current_user.username
    scenario = create_business_for_user(current_user, name, owner_name, emoji=emoji, color=color)
    set_current_business_id(scenario.id)
    return jsonify({'success': True, 'business_id': scenario.id, 'slug': business_slug(scenario.name),
                    'business': summary(scenario), 'message': f'{scenario.name} created'})


@manager_api_bp.route('/api/business/<business_ref>', methods=['DELETE'])
@login_required
def delete_business(business_ref):
    """Delete one of the caller's locations (never the last one)."""
    if is_demo_id(business_ref):
        return json_error('Demo businesses cannot be deleted.', 400)
    row = db_service.get_db_business(business_ref)
    if not row or not user_owns(row):
        return json_error('Business not found', 404)
    if len(list_owned_businesses()) <= 1:
        return json_error('You need at least one location. Rename this one instead of deleting it.', 400)
    name = row.name
    db_service.delete_business_from_db(row.business_id)
    remaining = list_owned_businesses()
    set_current_business_id(remaining[0].business_id if remaining else None)
    return jsonify({'success': True, 'message': f'{name} deleted',
                    'redirect': f"/{business_slug(remaining[0].name)}/schedule" if remaining else '/app'})


# ---- Per-business scheduling policies (stored as JSON) ----------------------

@manager_api_bp.route('/api/business/<business_ref>/settings', methods=['GET'])
def get_business_settings(business_ref):
    business = require_business(business_ref)
    if is_demo_id(business.id):
        if current_user.is_authenticated:
            rec = UserBusinessSettings.query.filter_by(user_id=current_user.id, business_id=business.id).first()
            return jsonify({'success': True, 'settings': rec.get_settings() if rec else {}, 'type': 'user'})
        return jsonify({'success': True, 'settings': {}, 'type': 'default'})
    rec = BusinessSettings.query.filter_by(business_id=business.id).first()
    return jsonify({'success': True, 'settings': rec.get_settings() if rec else {}, 'type': 'global'})


@manager_api_bp.route('/api/business/<business_ref>/settings', methods=['POST', 'PUT'])
@login_required
def save_business_settings(business_ref):
    business = require_business(business_ref)
    settings = request_json().get('settings', {})
    if not isinstance(settings, dict):
        return json_error('settings must be an object')
    if is_demo_id(business.id):
        rec = UserBusinessSettings.query.filter_by(user_id=current_user.id, business_id=business.id).first()
        if not rec:
            rec = UserBusinessSettings(user_id=current_user.id, business_id=business.id)
            db.session.add(rec)
        rec.set_settings(settings)
        db.session.commit()
        return jsonify({'success': True, 'message': 'Settings saved for your account', 'type': 'user'})
    rec = BusinessSettings.query.filter_by(business_id=business.id).first()
    if not rec:
        rec = BusinessSettings(business_id=business.id, owner_id=current_user.id)
        db.session.add(rec)
    rec.set_settings(settings)
    db.session.commit()
    return jsonify({'success': True, 'message': 'Settings saved', 'type': 'global'})


# =============================================================================
# EMPLOYEES
# =============================================================================

def _employee_from_payload(data: dict, business, employee: Employee = None) -> Employee:
    """Apply a JSON payload to a new or existing Employee."""
    if employee is None:
        employee = Employee(id=f"emp_{uuid.uuid4().hex[:8]}", name='New Employee')
        for day in business.days_open:
            employee.add_availability(day, business.start_hour, business.end_hour)

    if 'name' in data:
        employee.name = (data.get('name') or '').strip() or employee.name
    if 'email' in data:
        employee.email = (data.get('email') or '').strip().lower() or None
    if 'phone' in data:
        employee.phone = (data.get('phone') or '').strip() or None
    if 'classification' in data:
        employee.classification = EmployeeClassification.FULL_TIME if data['classification'] == 'full_time' else EmployeeClassification.PART_TIME
    if 'min_hours' in data:
        employee.min_hours = max(0, as_int(data['min_hours'], employee.min_hours))
    if 'max_hours' in data:
        employee.max_hours = max(1, as_int(data['max_hours'], employee.max_hours))
    if employee.max_hours < employee.min_hours:
        employee.max_hours = employee.min_hours
    if 'roles' in data:
        valid = {r.id for r in business.roles}
        employee.roles = [r for r in (data.get('roles') or []) if r in valid]
    for flag in ('needs_supervision', 'can_supervise', 'overtime_allowed'):
        if flag in data:
            setattr(employee, flag, bool(data[flag]))
    if 'hourly_rate' in data:
        employee.hourly_rate = max(0.0, as_float(data['hourly_rate'], employee.hourly_rate))
    if 'color' in data and data['color']:
        employee.color = str(data['color'])[:20]
    if 'notify_email' in data:
        employee.notify_email = bool(data['notify_email'])
    if 'notify_sms' in data:
        employee.notify_sms = bool(data['notify_sms'])
    return employee


def generate_temp_password(length=10) -> str:
    alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def create_or_get_employee_user(db_employee: DBEmployee, email: str, name: str):
    """Login account for an employee. Returns (user, temp_password_or_None) or (None, None) if taken."""
    email = email.lower().strip()
    existing = User.query.filter_by(email=email).first()
    if existing:
        if existing.linked_employee_id in (None, db_employee.id):
            existing.linked_employee_id = db_employee.id
            db.session.commit()
            return existing, None
        return None, None  # linked to a different employee record

    temp_password = generate_temp_password()
    base = re.sub(r'[^a-z0-9_]', '', email.split('@')[0].lower())
    if len(base) < 3:
        base = f'employee_{base}'
    username, n = base, 1
    while User.query.filter_by(username=username).first():
        username = f'{base}{n}'
        n += 1
    parts = (name or '').split()
    user = User(
        email=email, username=username,
        first_name=parts[0] if parts else '', last_name=' '.join(parts[1:]) if len(parts) > 1 else '',
        linked_employee_id=db_employee.id, must_change_password=True, is_active=True, is_verified=True,
    )
    user.set_password(temp_password)
    db.session.add(user)
    db.session.commit()
    return user, temp_password


def _send_invite(business, employee: Employee, by_email: bool, by_sms: bool):
    """Create the login account if needed and send the invitation. Returns (methods, errors)."""
    if is_demo_id(business.id):
        return [], ['Invitations are not available in demo mode.']
    db_emp = DBEmployee.query.filter_by(employee_id=employee.id).first()
    if not db_emp:
        return [], ['Employee not found in database']
    if by_email and not employee.email:
        return [], ['No email address on file']
    if by_sms and not employee.phone:
        return [], ['No phone number on file']

    temp_password = None
    if employee.email:
        user, temp_password = create_or_get_employee_user(db_emp, employee.email, employee.name)
        if user is None:
            return [], ['That email is already linked to a different employee account']

    base = site_url()
    portal_url = f"{base}/employee/{business_slug(business.name)}/{db_emp.id}/schedule"
    contact = contact_for(employee)
    if not by_email:
        contact['email'] = None
    if not by_sms:
        contact['phone'] = None
    results = send_invitation_now(contact, business.name, portal_url, f"{base}/auth/login", temp_password)
    methods = [ch for ch, ok, _ in results if ok]
    errors = [f"{ch}: {msg}" for ch, ok, msg in results if not ok]
    return methods, errors


def _invite_response(payload: dict, business, employee: Employee, data: dict):
    if data.get('send_invite') and (data.get('invite_by_email') or data.get('invite_by_sms')):
        methods, errors = _send_invite(business, employee, bool(data.get('invite_by_email')), bool(data.get('invite_by_sms')))
        if methods:
            payload['invitation_sent'] = True
            payload['invitation_methods'] = methods
            payload['message'] += f" Invitation sent via {', '.join(methods)}."
        if errors:
            payload['invitation_errors'] = errors
    return payload


@manager_api_bp.route('/api/employees', methods=['GET'])
def get_employees():
    business = require_business(_business_ref({}))
    _attach_db_ids(business)
    return jsonify({
        'success': True,
        'employees': [e.to_dict() for e in business.employees],
        'roles': [r.to_dict() for r in business.roles],
        'days': DAYS_OF_WEEK,
        'hours': list(business.get_operating_hours()),
    })


@manager_api_bp.route('/api/employees', methods=['POST'])
def add_employee():
    data = request_json()
    business = require_business(_business_ref(data))

    email = (data.get('email') or '').strip().lower()
    if email:
        if any((e.email or '').lower() == email for e in business.employees):
            return json_error(f'Another employee already uses "{email}".')
        taken = User.query.filter_by(email=email).first()
        if taken and taken.linked_employee_id is not None:
            return json_error(f'An employee account already exists with the email "{email}".')

    employee = _employee_from_payload(data, business)
    business.employees.append(employee)
    persist(business)
    _attach_db_ids(business)

    payload = {'success': True, 'employee': employee.to_dict(), 'message': f'{employee.name} added.'}
    return jsonify(_invite_response(payload, business, employee, data))


@manager_api_bp.route('/api/employees/<emp_id>', methods=['PUT'])
def update_employee(emp_id):
    data = request_json()
    business = require_business(_business_ref(data))
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found. Refresh the page and try again.', 404)

    new_email = (data.get('email') or '').strip().lower() if 'email' in data else None
    if new_email and new_email != (employee.email or '').lower():
        if any((e.email or '').lower() == new_email for e in business.employees if e.id != emp_id):
            return json_error(f'Another employee already uses "{new_email}".')

    _employee_from_payload(data, business, employee)
    persist(business)
    _attach_db_ids(business)

    # Keep the login account's email in sync
    if new_email and not is_demo_id(business.id):
        db_emp = DBEmployee.query.filter_by(employee_id=emp_id).first()
        if db_emp:
            linked = User.query.filter_by(linked_employee_id=db_emp.id).first()
            if linked and linked.email != new_email and not User.query.filter_by(email=new_email).first():
                linked.email = new_email
                db.session.commit()

    payload = {'success': True, 'employee': employee.to_dict(), 'message': f'{employee.name} updated.'}
    return jsonify(_invite_response(payload, business, employee, data))


@manager_api_bp.route('/api/employees/<emp_id>', methods=['DELETE'])
def delete_employee(emp_id):
    business = require_business(_business_ref({}))
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found. Refresh the page and try again.', 404)
    business.employees = [e for e in business.employees if e.id != emp_id]
    persist(business)  # save_business_to_db removes the row and unlinks the login
    return jsonify({'success': True, 'message': f'{employee.name} removed'})


@manager_api_bp.route('/api/employees/<emp_id>/invite', methods=['POST'])
@login_required
def send_employee_invitation(emp_id):
    data = request_json()
    business = require_business(_business_ref(data), allow_demo=False)
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found', 404)
    by_email = bool(data.get('email', True))
    by_sms = bool(data.get('sms', False))
    if not by_email and not by_sms:
        return json_error('Choose at least one way to send the invitation.')
    methods, errors = _send_invite(business, employee, by_email, by_sms)
    if not methods:
        return json_error(errors[0] if errors else 'Could not send the invitation.', 500)
    db_emp = DBEmployee.query.filter_by(employee_id=employee.id).first()
    return jsonify({
        'success': True,
        'message': f"Invitation sent to {employee.name} via {', '.join(methods)}",
        'invitation_methods': methods,
        'invitation_errors': errors,
        'portal_url': f"{site_url()}/employee/{business_slug(business.name)}/{db_emp.id}/schedule" if db_emp else None,
    })


@manager_api_bp.route('/api/email/status', methods=['GET'])
def email_status():
    email = get_email_service()
    sms = get_sms_service()
    return jsonify({
        'configured': email.is_configured(),
        'email_configured': email.is_configured(),
        'sms_configured': sms.is_configured(),
    })


# ---- Availability ----------------------------------------------------------

def _apply_availability(employee: Employee, data: dict):
    """Replace an employee's availability from either range or slot format."""
    employee.clear_availability()
    employee.clear_preferences()
    employee.clear_time_off()

    availability = data.get('availability', [])
    if isinstance(availability, dict):
        # {"0": [[9, 17.5], [18, 21]], ...} keeps 15-minute precision
        for day_str, ranges in availability.items():
            day = as_int(day_str, -1)
            if day < 0 or day > 6:
                continue
            for pair in ranges or []:
                try:
                    start, end = float(pair[0]), float(pair[1])
                except (TypeError, ValueError, IndexError):
                    continue
                if end > start:
                    employee.add_availability(day, max(0.0, start), min(24.0, end))
    else:
        by_day = {}
        for slot in availability or []:
            try:
                by_day.setdefault(int(slot['day']), []).append(int(slot['hour']))
            except (KeyError, TypeError, ValueError):
                continue
        for day, hours in by_day.items():
            hours = sorted(set(hours))
            start, end = hours[0], hours[0] + 1
            for h in hours[1:]:
                if h == end:
                    end = h + 1
                else:
                    employee.add_availability(day, float(start), float(end))
                    start, end = h, h + 1
            employee.add_availability(day, float(start), float(end))

    for slot in data.get('preferences', []) or []:
        try:
            employee.add_preference(int(slot['day']), float(slot['hour']), float(slot['hour']) + 1)
        except (KeyError, TypeError, ValueError):
            continue
    for slot in data.get('time_off', []) or []:
        try:
            employee.add_time_off(int(slot['day']), float(slot['hour']), float(slot['hour']) + 1)
        except (KeyError, TypeError, ValueError):
            continue


def _availability_response(employee: Employee, data: dict):
    return jsonify({
        'success': True,
        'employee': employee.to_dict(),
        'availability': data.get('availability') if isinstance(data.get('availability'), dict) else None,
        'message': 'Availability updated',
    })


@manager_api_bp.route('/api/employees/<emp_id>/availability', methods=['PUT'])
def update_availability(emp_id):
    data = request_json()
    business = require_business(_business_ref(data))
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found', 404)
    _apply_availability(employee, data)
    persist(business)
    return _availability_response(employee, data)


@manager_api_bp.route('/api/<business_ref>/employees/<emp_id>/availability', methods=['PUT'])
def update_availability_by_slug(business_ref, emp_id):
    data = request_json()
    business = require_business(business_ref)
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found', 404)
    _apply_availability(employee, data)
    persist(business)
    return _availability_response(employee, data)


@manager_api_bp.route('/api/employees/<emp_id>/availability-cell', methods=['PUT'])
def update_availability_cell(emp_id):
    """Toggle one hour cell: 'available' | 'preferred' | 'time-off' | 'none'."""
    data = request_json()
    business = require_business(_business_ref(data))
    employee = _find_employee(business, emp_id)
    if not employee:
        return json_error('Employee not found', 404)
    day, hour, state = as_int(data.get('day'), -1), as_int(data.get('hour'), -1), data.get('state')
    if not (0 <= day <= 6) or hour < 0:
        return json_error('Invalid day/hour')
    slot = TimeSlot(day, hour)
    employee.availability.discard(slot)
    employee.preferences.discard(slot)
    employee.time_off.discard(slot)
    if state in ('available', 'preferred'):
        employee.availability.add(slot)
    if state == 'preferred':
        employee.preferences.add(slot)
    if state == 'time-off':
        employee.time_off.add(slot)
    # Rebuild ranges from slots so both representations agree
    _rebuild_ranges_from_slots(employee)
    persist(business)
    return jsonify({'success': True, 'message': 'Cell updated'})


def _rebuild_ranges_from_slots(employee: Employee):
    from scheduler.models import AvailabilityRange

    def to_ranges(slots):
        by_day = {}
        for s in slots:
            by_day.setdefault(s.day, []).append(s.hour)
        out = []
        for day, hours in by_day.items():
            hours.sort()
            start, prev = hours[0], hours[0]
            for h in hours[1:]:
                if h != prev + 1:
                    out.append(AvailabilityRange(day, start, prev + 1))
                    start = h
                prev = h
            out.append(AvailabilityRange(day, start, prev + 1))
        return out

    employee.availability_ranges = to_ranges(employee.availability)
    employee.preference_ranges = to_ranges(employee.preferences)
    employee.time_off_ranges = to_ranges(employee.time_off)


# =============================================================================
# BUSINESS SETTINGS: hours, days, roles
# =============================================================================

@manager_api_bp.route('/api/settings', methods=['GET'])
def get_settings():
    business = require_business(_business_ref({}))
    return jsonify({'success': True, 'settings': {
        'hours': {'start_hour': business.start_hour, 'end_hour': business.end_hour},
        'days_open': business.days_open,
        'roles': [r.to_dict() for r in business.roles],
        'coverage_requirements': [c.to_dict() for c in business.coverage_requirements],
    }})


@manager_api_bp.route('/api/settings', methods=['PUT'])
def update_settings():
    """Operating hours and open days. Coverage is regenerated to match."""
    data = request_json()
    business = require_business(_business_ref(data))
    hours = data.get('hours') or {}
    if 'start_hour' in hours:
        business.start_hour = min(23, max(0, as_int(hours['start_hour'], business.start_hour)))
    if 'end_hour' in hours:
        business.end_hour = min(24, max(1, as_int(hours['end_hour'], business.end_hour)))
    if business.end_hour <= business.start_hour:
        return json_error('Closing time must be after opening time.')
    if 'days_open' in data:
        days = sorted({as_int(d, -1) for d in (data.get('days_open') or [])} - {-1})
        if not days:
            return json_error('Choose at least one open day.')
        business.days_open = [d for d in days if 0 <= d <= 6]
    if 'has_completed_setup' in data:
        business.has_completed_setup = bool(data['has_completed_setup'])
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'message': 'Settings saved',
                    'settings': {'hours': {'start_hour': business.start_hour, 'end_hour': business.end_hour},
                                 'days_open': business.days_open}})


@manager_api_bp.route('/api/<business_ref>/settings/roles', methods=['GET'])
def get_roles(business_ref):
    business = require_business(business_ref)
    return jsonify({'success': True, 'roles': [r.to_dict() for r in business.roles]})


@manager_api_bp.route('/api/<business_ref>/settings/roles', methods=['POST'])
def add_role(business_ref):
    business = require_business(business_ref)
    data = request_json()
    name = (data.get('name') or '').strip() or 'New Role'
    role = Role(id=f"role_{uuid.uuid4().hex[:6]}", name=name, color=(data.get('color') or '#6366f1')[:20])
    business.roles.append(role)
    persist(business)
    return jsonify({'success': True, 'role': role.to_dict(), 'message': f'Role "{name}" added'})


@manager_api_bp.route('/api/<business_ref>/settings/roles/<role_id>', methods=['PUT'])
def update_role(business_ref, role_id):
    business = require_business(business_ref)
    role = next((r for r in business.roles if r.id == role_id), None)
    if not role:
        return json_error('Role not found', 404)
    data = request_json()
    if data.get('name'):
        role.name = str(data['name']).strip()[:100]
    if data.get('color'):
        role.color = str(data['color'])[:20]
    persist(business)
    return jsonify({'success': True, 'role': role.to_dict(), 'message': 'Role updated'})


@manager_api_bp.route('/api/<business_ref>/settings/roles/<role_id>', methods=['DELETE'])
def delete_role(business_ref, role_id):
    business = require_business(business_ref)
    role = next((r for r in business.roles if r.id == role_id), None)
    if not role:
        return json_error('Role not found', 404)
    business.roles = [r for r in business.roles if r.id != role_id]
    for emp in business.employees:
        emp.roles = [r for r in emp.roles if r != role_id]
    for shift in business.shift_templates:
        shift.roles = [r for r in shift.roles if r.role_id != role_id]
    business.role_coverage_configs = [c for c in business.role_coverage_configs if c.role_id != role_id]
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'message': f'Role "{role.name}" removed'})


# =============================================================================
# COVERAGE: shifts, peak periods, per-role config
# =============================================================================

@manager_api_bp.route('/api/coverage', methods=['GET'])
def get_coverage_requirements():
    business = require_business(_business_ref({}))
    coverage = {}
    for req in business.coverage_requirements:
        coverage.setdefault(f"{req.day},{req.hour}", []).append({
            'role_id': req.role_id, 'min_staff': req.min_staff, 'max_staff': req.max_staff, 'is_peak': req.is_peak,
        })
    return jsonify({'success': True, 'coverage': coverage,
                    'peak_periods': [p.to_dict() for p in business.peak_periods],
                    'role_configs': [c.to_dict() for c in business.role_coverage_configs],
                    'days': business.days_open, 'hours': list(business.get_operating_hours())})


@manager_api_bp.route('/api/settings/coverage-mode', methods=['GET'])
def get_coverage_mode():
    business = require_business(_business_ref({}))
    return jsonify({'success': True, 'coverage_mode': business.coverage_mode.value,
                    'has_completed_setup': business.has_completed_setup,
                    'shift_templates': [s.to_dict() for s in business.shift_templates],
                    'role_configs': [c.to_dict() for c in business.role_coverage_configs]})


@manager_api_bp.route('/api/settings/coverage-mode', methods=['PUT'])
def set_coverage_mode():
    data = request_json()
    business = require_business(_business_ref(data))
    mode = data.get('mode', 'shifts')
    if mode not in ('shifts', 'detailed'):
        return json_error(f'Invalid coverage mode: {mode}')
    business.coverage_mode = CoverageMode(mode)
    if data.get('complete_setup'):
        business.has_completed_setup = True
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'coverage_mode': mode, 'has_completed_setup': business.has_completed_setup,
                    'coverage_count': len(business.coverage_requirements), 'message': f'Switched to {mode} mode'})


def _shift_roles(items):
    out = []
    for req in items or []:
        role_id = req.get('role_id')
        if not role_id:
            continue
        count = max(0, as_int(req.get('count'), 1))
        max_count = max(count, as_int(req.get('max_count'), count))
        out.append(ShiftRoleRequirement(role_id=role_id, count=count, max_count=max_count))
    return out


@manager_api_bp.route('/api/settings/shifts', methods=['GET'])
def get_shift_templates():
    business = require_business(_business_ref({}))
    return jsonify({'success': True, 'shifts': [s.to_dict() for s in business.shift_templates],
                    'roles': [r.to_dict() for r in business.roles]})


@manager_api_bp.route('/api/settings/shifts', methods=['POST'])
def add_shift_template():
    data = request_json()
    business = require_business(_business_ref(data))
    start, end = as_int(data.get('start_hour'), business.start_hour), as_int(data.get('end_hour'), business.end_hour)
    if end <= start:
        return json_error('Shift end must be after its start.')
    shift = ShiftTemplate(
        id=f"shift_{uuid.uuid4().hex[:6]}", name=(data.get('name') or 'New Shift').strip()[:100],
        start_hour=start, end_hour=end, roles=_shift_roles(data.get('roles')),
        days=[d for d in (data.get('days') or list(range(7))) if 0 <= as_int(d, -1) <= 6],
        color=(data.get('color') or '#6366f1')[:20],
    )
    business.shift_templates.append(shift)
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'shift': shift.to_dict(), 'message': 'Shift added'})


@manager_api_bp.route('/api/settings/shifts/<shift_id>', methods=['PUT'])
def update_shift_template(shift_id):
    data = request_json()
    business = require_business(_business_ref(data))
    shift = next((s for s in business.shift_templates if s.id == shift_id), None)
    if not shift:
        return json_error('Shift not found', 404)
    if 'name' in data:
        shift.name = (data.get('name') or shift.name).strip()[:100]
    if 'start_hour' in data:
        shift.start_hour = as_int(data['start_hour'], shift.start_hour)
    if 'end_hour' in data:
        shift.end_hour = as_int(data['end_hour'], shift.end_hour)
    if shift.end_hour <= shift.start_hour:
        return json_error('Shift end must be after its start.')
    if 'days' in data:
        shift.days = [as_int(d, -1) for d in (data.get('days') or []) if 0 <= as_int(d, -1) <= 6]
    if 'color' in data and data['color']:
        shift.color = str(data['color'])[:20]
    if 'roles' in data:
        shift.roles = _shift_roles(data['roles'])
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'shift': shift.to_dict(), 'message': 'Shift updated'})


@manager_api_bp.route('/api/settings/shifts/<shift_id>', methods=['DELETE'])
def delete_shift_template(shift_id):
    business = require_business(_business_ref({}))
    shift = next((s for s in business.shift_templates if s.id == shift_id), None)
    if not shift:
        return json_error('Shift not found', 404)
    business.shift_templates = [s for s in business.shift_templates if s.id != shift_id]
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'message': f'Shift "{shift.name}" removed'})


@manager_api_bp.route('/api/settings/peak-periods', methods=['GET'])
def get_peak_periods():
    business = require_business(_business_ref({}))
    return jsonify({'success': True, 'peak_periods': [p.to_dict() for p in business.peak_periods]})


@manager_api_bp.route('/api/settings/peak-periods', methods=['PUT'])
def update_peak_periods():
    data = request_json()
    business = require_business(_business_ref(data))
    periods = []
    for p in data.get('peak_periods', []) or []:
        periods.append(PeakPeriod(
            name=(p.get('name') or 'Peak')[:50], start_hour=as_int(p.get('start_hour'), 8),
            end_hour=as_int(p.get('end_hour'), 10),
            days=[as_int(d, -1) for d in (p.get('days') or list(range(7))) if 0 <= as_int(d, -1) <= 6],
        ))
    business.peak_periods = periods
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'peak_periods': [p.to_dict() for p in business.peak_periods],
                    'message': 'Peak periods saved'})


@manager_api_bp.route('/api/settings/role-coverage', methods=['GET'])
def get_role_coverage():
    business = require_business(_business_ref({}))
    return jsonify({'success': True, 'role_configs': [c.to_dict() for c in business.role_coverage_configs],
                    'roles': [r.to_dict() for r in business.roles]})


def _role_config_from(data: dict, existing: RoleCoverageConfig = None) -> RoleCoverageConfig:
    cfg = existing or RoleCoverageConfig(role_id=data.get('role_id'))
    if 'default_min_staff' in data:
        cfg.default_min_staff = max(0, as_int(data['default_min_staff'], cfg.default_min_staff))
    if 'default_max_staff' in data:
        cfg.default_max_staff = max(cfg.default_min_staff, as_int(data['default_max_staff'], cfg.default_max_staff))
    if 'peak_boost' in data:
        cfg.peak_boost = max(0, as_int(data['peak_boost'], cfg.peak_boost))
    if 'required_hours' in data:
        cfg.required_hours = [h for h in (data['required_hours'] or []) if isinstance(h, dict)]
    if 'required_days' in data:
        cfg.required_days = [as_int(d, -1) for d in (data['required_days'] or []) if 0 <= as_int(d, -1) <= 6]
    return cfg


@manager_api_bp.route('/api/settings/role-coverage', methods=['PUT'])
def update_role_coverage():
    data = request_json()
    business = require_business(_business_ref(data))
    valid = {r.id for r in business.roles}
    business.role_coverage_configs = [
        _role_config_from(c) for c in (data.get('role_configs') or []) if c.get('role_id') in valid
    ]
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'role_configs': [c.to_dict() for c in business.role_coverage_configs],
                    'coverage_count': len(business.coverage_requirements), 'message': 'Role coverage saved'})


@manager_api_bp.route('/api/settings/role-coverage/<role_id>', methods=['PUT'])
def update_single_role_coverage(role_id):
    data = request_json()
    business = require_business(_business_ref(data))
    if role_id not in {r.id for r in business.roles}:
        return json_error('Role not found', 404)
    cfg = next((c for c in business.role_coverage_configs if c.role_id == role_id), None)
    if cfg is None:
        cfg = RoleCoverageConfig(role_id=role_id)
        business.role_coverage_configs.append(cfg)
    _role_config_from(data, cfg)
    business.coverage_requirements = business.generate_coverage_requirements()
    persist(business)
    return jsonify({'success': True, 'role_config': cfg.to_dict(), 'message': 'Coverage saved'})


# =============================================================================
# STATS
# =============================================================================

@manager_api_bp.route('/api/stats')
def get_stats():
    business = require_business(_business_ref({}))
    ft = sum(1 for e in business.employees if e.is_full_time)
    return jsonify({
        'business': {'id': business.id, 'name': business.name, 'description': business.description},
        'coverage': {
            'total_slots_required': sum(r.min_staff for r in business.coverage_requirements),
            'hours_per_day': len(list(business.get_operating_hours())),
            'days_per_week': len(business.days_open),
        },
        'employees': {
            'total': len(business.employees), 'full_time': ft, 'part_time': len(business.employees) - ft,
            'needs_supervision': sum(1 for e in business.employees if e.needs_supervision),
            'can_supervise': sum(1 for e in business.employees if e.can_supervise),
            'overtime_allowed': sum(1 for e in business.employees if e.overtime_allowed),
        },
        'roles': {'total': len(business.roles), 'list': [r.to_dict() for r in business.roles]},
    })


# =============================================================================
# TIME OFF (manager side)
# =============================================================================

def _db_business_or_error(business):
    if is_demo_id(business.id):
        raise BusinessAccessError('Time off is not available for demo businesses.', 400)
    row = db_service.get_db_business(business.id)
    if not row:
        raise BusinessAccessError('Business not found', 404)
    return row


def _pto_with_names(requests_, row):
    emps = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    out = []
    for req in requests_:
        d = req.to_dict()
        emp = emps.get(req.employee_id)
        d['employee_name'] = emp.name if emp else 'Unknown'
        d['employee_color'] = emp.color if emp else '#888888'
        d['employee_db_id'] = emp.id if emp else None
        out.append(d)
    return out


@manager_api_bp.route('/api/<business_ref>/pto', methods=['GET'])
@login_required
def get_business_pto_requests(business_ref):
    business = require_business(business_ref, allow_demo=False)
    row = _db_business_or_error(business)
    query = PTORequest.query.filter_by(business_db_id=row.id)
    if request.args.get('status'):
        query = query.filter_by(status=request.args['status'])
    if request.args.get('employee_id'):
        query = query.filter_by(employee_id=request.args['employee_id'])
    requests_ = query.order_by(PTORequest.created_at.desc()).all()
    return jsonify({'success': True, 'pto_requests': _pto_with_names(requests_, row)})


@manager_api_bp.route('/api/<business_ref>/pto/pending/count', methods=['GET'])
@login_required
def get_pending_pto_count(business_ref):
    business = require_business(business_ref, allow_demo=False)
    row = _db_business_or_error(business)
    count = PTORequest.query.filter_by(business_db_id=row.id, status='pending').count()
    return jsonify({'success': True, 'count': count})


def _remove_conflicting_shifts(row, pto: PTORequest):
    """Drop any scheduled shifts inside an approved time-off window. Returns count."""
    removed = 0
    for schedule in DBSchedule.query.filter_by(business_db_id=row.id).all():
        week_start = schedule.week_start_date
        week_end = week_start + timedelta(days=6)
        if not (week_start <= pto.end_date and week_end >= pto.start_date):
            continue
        affected_days = set()
        for shift in DBShiftAssignment.query.filter_by(schedule_id=schedule.id, employee_id=pto.employee_id).all():
            shift_date = week_start + timedelta(days=shift.day)
            if pto.start_date <= shift_date <= pto.end_date:
                affected_days.add(shift.day)
                db.session.delete(shift)
                removed += 1
        if affected_days:
            data = schedule.get_schedule_data()
            data['assignments'] = [a for a in data.get('assignments', [])
                                   if not (a.get('employee_id') == pto.employee_id and a.get('day') in affected_days)]
            slots = data.get('slot_assignments', {})
            for key, entries in list(slots.items()):
                try:
                    day = int(key.split(',')[0])
                except ValueError:
                    continue
                if day in affected_days:
                    slots[key] = [e for e in entries
                                  if (e.get('employee_id') if isinstance(e, dict) else e[0]) != pto.employee_id]
            data['slot_assignments'] = slots
            schedule.set_schedule_data(data)
    return removed


def _decide_pto(business_ref, request_id, approve: bool):
    business = require_business(business_ref, allow_demo=False)
    row = _db_business_or_error(business)
    pto = PTORequest.query.filter_by(request_id=request_id, business_db_id=row.id).first()
    if not pto:
        return json_error('Time-off request not found', 404)
    if pto.status != 'pending':
        return json_error('This request was already reviewed.')

    note = (request_json().get('note') or '').strip()
    removed = _remove_conflicting_shifts(row, pto) if approve else 0
    pto.status = 'approved' if approve else 'denied'
    pto.reviewed_by_id = current_user.id
    pto.reviewed_at = datetime.utcnow()
    if note:
        pto.manager_note = note
    db.session.commit()

    db_emp = DBEmployee.query.filter_by(business_db_id=row.id, employee_id=pto.employee_id).first()
    if db_emp:
        notify_pto_decision(contact_for(db_emp), db_emp.id, business.name, business_slug(business.name),
                            approve, pto.start_date, pto.end_date, note, removed)

    name = db_emp.name if db_emp else pto.employee_id
    if approve:
        message = 'Time off approved.'
        if removed:
            message = f'Time off approved. {removed} scheduled shift(s) for {name} were removed and are now open.'
    else:
        message = 'Time off denied.'
    return jsonify({'success': True, 'message': message, 'pto_request': pto.to_dict(), 'shifts_removed': removed})


@manager_api_bp.route('/api/<business_ref>/pto/<request_id>/approve', methods=['PUT'])
@login_required
def approve_pto_request(business_ref, request_id):
    return _decide_pto(business_ref, request_id, approve=True)


@manager_api_bp.route('/api/<business_ref>/pto/<request_id>/deny', methods=['PUT'])
@login_required
def deny_pto_request(business_ref, request_id):
    return _decide_pto(business_ref, request_id, approve=False)
