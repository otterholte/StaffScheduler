"""This-week edits: staffing overrides, event templates, and date exceptions.

Manager endpoints resolve the business through `require_business()`; the
employee endpoints use `require_employee_access()` so a team member can only
touch their own exceptions.
"""
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_login import login_required

from models import db, AvailabilityException, DBEmployee, EventTemplate
from services import week_overrides as wk
from services.business_context import (
    BusinessAccessError, is_demo_id, require_business, require_employee_access,
)
from services.common import json_error, parse_week_start, request_json
import db_service

week_api_bp = Blueprint('week_api', __name__)


@week_api_bp.errorhandler(BusinessAccessError)
def _access_error(err):
    return json_error(str(err), err.status)


def _row_for(scenario):
    return None if is_demo_id(scenario.id) else db_service.get_db_business(scenario.id)


def _week_from_args():
    return parse_week_start(request.args.get('weekStart'), request.args.get('weekOffset', 0, type=int))


def _exception_payload(row, excs):
    emps = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()} if row else {}
    out = []
    for exc in excs:
        d = exc.to_dict()
        emp = emps.get(exc.employee_id)
        d['employee_name'] = emp.name if emp else 'Unknown'
        d['employee_color'] = emp.color if emp else '#888888'
        out.append(d)
    return out


# ------------------------------------------------------------ week context

@week_api_bp.route('/api/week/context', methods=['GET'])
def week_context():
    """Everything the schedule page needs for one week: overrides, templates, exceptions."""
    scenario = require_business(request.args.get('businessId'))
    week_start = _week_from_args()
    row = _row_for(scenario)
    week_end = week_start + timedelta(days=6)
    overrides = wk.load_overrides(row, week_start)
    return jsonify({
        'success': True,
        'week_start': week_start.isoformat(),
        'overrides': overrides,
        'change_count': wk.count_changes(overrides),
        'templates': wk.list_templates(row),
        'exceptions': _exception_payload(row, wk.exceptions_between(row, week_start, week_end)),
        'persisted': row is not None,
    })


@week_api_bp.route('/api/week/overrides', methods=['PUT'])
@login_required
def save_week_overrides():
    data = request_json()
    scenario = require_business(data.get('businessId'), allow_demo=False)
    week_start = parse_week_start(data.get('weekStart'), data.get('weekOffset', 0))
    row = _row_for(scenario)
    if not row:
        return json_error('Sign up to save changes to a week.', 400)
    saved = wk.save_overrides(row, week_start, data.get('overrides') or {})
    return jsonify({'success': True, 'overrides': saved, 'change_count': wk.count_changes(saved),
                    'week_start': week_start.isoformat()})


# ---------------------------------------------------------- event templates

@week_api_bp.route('/api/event-templates', methods=['GET'])
def list_event_templates():
    scenario = require_business(request.args.get('businessId'))
    return jsonify({'success': True, 'templates': wk.list_templates(_row_for(scenario))})


@week_api_bp.route('/api/event-templates', methods=['POST'])
@login_required
def create_event_template():
    data = request_json()
    scenario = require_business(data.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    if not row:
        return json_error('Sign up to save templates.', 400)
    name = str(data.get('name') or '').strip()
    if not name:
        return json_error('Give the template a name.')
    items = wk.clean_template_items(data.get('items'))
    if not items:
        return json_error('A template needs at least one staffing need.')
    tpl = EventTemplate(business_db_id=row.id, name=name[:100],
                        mode='replace' if data.get('mode') == 'replace' else 'add')
    tpl.set_items(items)
    db.session.add(tpl)
    db.session.commit()
    return jsonify({'success': True, 'template': tpl.to_dict(), 'templates': wk.list_templates(row)})


@week_api_bp.route('/api/event-templates/<template_id>', methods=['PUT'])
@login_required
def update_event_template(template_id):
    data = request_json()
    scenario = require_business(data.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    tpl = EventTemplate.query.filter_by(business_db_id=row.id, template_id=template_id).first() if row else None
    if not tpl:
        return json_error('Template not found.', 404)
    if 'name' in data and str(data['name']).strip():
        tpl.name = str(data['name']).strip()[:100]
    if data.get('mode') in ('add', 'replace'):
        tpl.mode = data['mode']
    if 'items' in data:
        items = wk.clean_template_items(data.get('items'))
        if not items:
            return json_error('A template needs at least one staffing need.')
        tpl.set_items(items)
    db.session.commit()
    return jsonify({'success': True, 'template': tpl.to_dict(), 'templates': wk.list_templates(row)})


@week_api_bp.route('/api/event-templates/<template_id>', methods=['DELETE'])
@login_required
def delete_event_template(template_id):
    scenario = require_business(request.args.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    tpl = EventTemplate.query.filter_by(business_db_id=row.id, template_id=template_id).first() if row else None
    if not tpl:
        return json_error('Template not found.', 404)
    db.session.delete(tpl)
    db.session.commit()
    return jsonify({'success': True, 'templates': wk.list_templates(row)})


# ---------------------------------------------------- availability exceptions

def _parse_exception(data: dict):
    """Validate an exception payload -> (fields dict) or (None, error message)."""
    try:
        start = datetime.strptime(str(data.get('date') or data.get('start_date')), '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None, 'Pick a date.'
    end = start
    if data.get('end_date'):
        try:
            end = datetime.strptime(str(data['end_date']), '%Y-%m-%d').date()
        except (TypeError, ValueError):
            return None, 'The end date is not valid.'
    if end < start:
        return None, 'The end date is before the start date.'
    if (end - start).days > 60:
        return None, 'Exceptions can cover at most 60 days at a time.'
    kind = 'available' if data.get('kind') == 'available' else 'unavailable'
    start_hour = end_hour = None
    if not data.get('all_day', True):
        try:
            start_hour, end_hour = float(data.get('start_hour')), float(data.get('end_hour'))
        except (TypeError, ValueError):
            return None, 'Pick a start and end time, or choose all day.'
        if end_hour <= start_hour:
            return None, 'The end time must be after the start time.'
    note = str(data.get('note') or '').strip()[:300]
    return {'start': start, 'end': end, 'kind': kind, 'start_hour': start_hour, 'end_hour': end_hour, 'note': note}, None


def _create_exceptions(row, employee_id: str, fields: dict, created_by: str):
    created = []
    day = fields['start']
    while day <= fields['end']:
        # Replace an existing exception of the same person/date/time window
        AvailabilityException.query.filter_by(
            business_db_id=row.id, employee_id=employee_id, date=day,
            start_hour=fields['start_hour'], end_hour=fields['end_hour']).delete()
        exc = AvailabilityException(business_db_id=row.id, employee_id=employee_id, date=day, kind=fields['kind'],
                                    start_hour=fields['start_hour'], end_hour=fields['end_hour'],
                                    note=fields['note'], created_by=created_by)
        db.session.add(exc)
        created.append(exc)
        day += timedelta(days=1)
    db.session.commit()
    return created


def _employee_exceptions(row, employee_id: str, include_past: bool = False):
    q = AvailabilityException.query.filter_by(business_db_id=row.id, employee_id=employee_id)
    if not include_past:
        q = q.filter(AvailabilityException.date >= date.today() - timedelta(days=7))
    return q.order_by(AvailabilityException.date.asc(), AvailabilityException.start_hour.asc()).all()


# Manager side: /api/employees/<model id>/exceptions
@week_api_bp.route('/api/employees/<emp_id>/exceptions', methods=['GET'])
@login_required
def manager_list_exceptions(emp_id):
    scenario = require_business(request.args.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    if not row:
        return jsonify({'success': True, 'exceptions': []})
    return jsonify({'success': True, 'exceptions': _exception_payload(row, _employee_exceptions(row, emp_id))})


@week_api_bp.route('/api/employees/<emp_id>/exceptions', methods=['POST'])
@login_required
def manager_add_exception(emp_id):
    data = request_json()
    scenario = require_business(data.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    if not row:
        return json_error('Sign up to save availability exceptions.', 400)
    if not any(e.id == emp_id for e in scenario.employees):
        return json_error('Employee not found.', 404)
    fields, err = _parse_exception(data)
    if err:
        return json_error(err)
    _create_exceptions(row, emp_id, fields, 'manager')
    return jsonify({'success': True, 'message': 'Exception saved',
                    'exceptions': _exception_payload(row, _employee_exceptions(row, emp_id))})


@week_api_bp.route('/api/employees/<emp_id>/exceptions/<exception_id>', methods=['DELETE'])
@login_required
def manager_delete_exception(emp_id, exception_id):
    scenario = require_business(request.args.get('businessId'), allow_demo=False)
    row = _row_for(scenario)
    exc = AvailabilityException.query.filter_by(business_db_id=row.id, employee_id=emp_id,
                                                exception_id=exception_id).first() if row else None
    if not exc:
        return json_error('Exception not found.', 404)
    db.session.delete(exc)
    db.session.commit()
    return jsonify({'success': True, 'exceptions': _exception_payload(row, _employee_exceptions(row, emp_id))})


# Employee side: /api/employee/<db id>/exceptions
@week_api_bp.route('/api/employee/<int:employee_id>/exceptions', methods=['GET'])
@login_required
def employee_list_exceptions(employee_id):
    _, row, db_employee = require_employee_access(employee_id)
    return jsonify({'success': True,
                    'exceptions': _exception_payload(row, _employee_exceptions(row, db_employee.employee_id))})


@week_api_bp.route('/api/employee/<int:employee_id>/exceptions', methods=['POST'])
@login_required
def employee_add_exception(employee_id):
    _, row, db_employee = require_employee_access(employee_id)
    fields, err = _parse_exception(request_json())
    if err:
        return json_error(err)
    if fields['kind'] != 'available':
        return json_error("Days you can't work go in as a request so your manager can approve them.")
    _create_exceptions(row, db_employee.employee_id, fields, 'employee')
    return jsonify({'success': True, 'message': 'Saved',
                    'exceptions': _exception_payload(row, _employee_exceptions(row, db_employee.employee_id))})


@week_api_bp.route('/api/employee/<int:employee_id>/exceptions/<exception_id>', methods=['DELETE'])
@login_required
def employee_delete_exception(employee_id, exception_id):
    _, row, db_employee = require_employee_access(employee_id)
    exc = AvailabilityException.query.filter_by(business_db_id=row.id, employee_id=db_employee.employee_id,
                                                exception_id=exception_id).first()
    if not exc:
        return json_error('Exception not found.', 404)
    db.session.delete(exc)
    db.session.commit()
    return jsonify({'success': True,
                    'exceptions': _exception_payload(row, _employee_exceptions(row, db_employee.employee_id))})
