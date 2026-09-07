"""
Schedule API: generate, find alternatives, poll progress, load, publish.

Generation is asynchronous (see services/schedule_jobs.py):

    POST /api/generate            -> {"success": true, "job_id": "..."}
    POST /api/alternative         -> same, but the result must differ from earlier ones
    GET  /api/schedule/job/<id>   -> {"status": "running"|"done"|"failed", "message", "progress", "result"}
    POST /api/reset               -> forget earlier solutions for the week
    GET  /api/schedule/load       -> the saved draft/published schedule for a week
    POST /api/schedule/publish    -> publish the week and notify staff
"""

from datetime import timedelta

from flask import Blueprint, current_app, jsonify
from flask_login import current_user

from models import db, DBEmployee
from services import schedule_jobs
from services.business_context import (
    BusinessAccessError, business_slug, is_demo_id, require_business, scenario_with_time_off,
)
from services.common import DAY_NAMES, format_shift_time, json_error, parse_week_start, request_json
from services.notifications import contact_for, notify_schedule_published
import db_service

schedule_api_bp = Blueprint('schedule_api', __name__)


@schedule_api_bp.errorhandler(BusinessAccessError)
def _access_error(err):
    return json_error(str(err), err.status)


def _week_from_request(data: dict):
    """Browser sends weekStart (its local Monday) and/or weekOffset."""
    return parse_week_start(data.get('weekStart'), data.get('weekOffset', 0))


def _start(kind: str):
    data = request_json()
    scenario = require_business(data.get('businessId'))
    week_start = _week_from_request(data)
    is_demo = is_demo_id(scenario.id)

    # The solver works on a copy that has approved time off blocked out
    working = scenario_with_time_off(scenario, week_start)

    owner_id = current_user.id if current_user.is_authenticated else None
    job_id = schedule_jobs.start_job(
        current_app._get_current_object(), working, owner_id, week_start,
        data.get('policies'), kind, is_demo,
    )
    return jsonify({
        'success': True,
        'job_id': job_id,
        'week_start': week_start.isoformat(),
        'message': 'Generating schedule...',
    })


@schedule_api_bp.route('/api/generate', methods=['POST'])
def generate_schedule():
    """Start a new schedule for the requested week."""
    return _start('generate')


@schedule_api_bp.route('/api/alternative', methods=['POST'])
def find_alternative():
    """Start a search for a schedule that differs from the ones already found."""
    return _start('alternative')


@schedule_api_bp.route('/api/schedule/job/<job_id>', methods=['GET'])
def job_status(job_id):
    """Poll a generation job. Includes the full result once the job is done."""
    job = schedule_jobs.load_job(job_id)
    if not job:
        return json_error('Job not found.', 404)
    # Only the owner (or anyone, for a demo job) may read it
    if job.owner_id is not None:
        if not current_user.is_authenticated or current_user.id != job.owner_id:
            return json_error('Not authorized.', 403)
    return jsonify({'success': True, **job.to_dict(include_result=True)})


@schedule_api_bp.route('/api/reset', methods=['POST'])
def reset_alternatives():
    """Forget the alternatives history for a week (next 'alternative' starts fresh)."""
    data = request_json()
    scenario = require_business(data.get('businessId'))
    week_start = _week_from_request(data)
    schedule_jobs.clear_history(scenario.id, week_start, is_demo_id(scenario.id))
    return jsonify({'success': True, 'message': 'Alternatives reset. The next search starts fresh.'})


@schedule_api_bp.route('/api/schedule/load', methods=['GET'])
def load_saved_schedule():
    """Return the saved schedule (draft or published) for a week, if any."""
    from flask import request
    scenario = require_business(request.args.get('businessId'))
    week_start = parse_week_start(request.args.get('weekStart'), request.args.get('weekOffset', 0, type=int))
    # "Nothing saved yet" is a normal answer, not an error, so it is a 200
    if is_demo_id(scenario.id):
        return jsonify({'success': False, 'message': 'Demo schedules are not saved on the server.'})

    schedule, status = db_service.get_schedule_with_status_from_db(scenario.id, week_start)
    if not schedule:
        return jsonify({'success': False, 'message': 'No saved schedule for this week'})
    return jsonify({
        'success': True,
        'schedule': schedule.to_dict(),
        'status': status,
        'week_start': week_start.isoformat(),
        'business': {'id': scenario.id, 'name': scenario.name, 'roles': [r.to_dict() for r in scenario.roles]},
        'employees': [e.to_dict() for e in scenario.employees],
    })


@schedule_api_bp.route('/api/schedule/publish', methods=['POST'])
def publish_schedule():
    """Mark the week's schedule as published and notify every employee with shifts info."""
    data = request_json()
    scenario = require_business(data.get('businessId'))
    week_start = _week_from_request(data)
    if is_demo_id(scenario.id):
        return json_error('Demo schedules cannot be published. Sign up to save and publish schedules.', 400)

    rec = db_service.publish_schedule_in_db(scenario.id, week_start)
    if not rec:
        return json_error('No schedule found to publish. Generate one first.', 404)

    notified = 0
    if data.get('notify', True):
        notified = _notify_employees_of_publish(scenario, rec, week_start)

    return jsonify({
        'success': True,
        'message': 'Schedule published!' + (f' {notified} staff notified.' if notified else ''),
        'notified': notified,
    })


def _notify_employees_of_publish(scenario, rec, week_start) -> int:
    """Build per-employee shift summaries and hand them to the notifier."""
    row = db_service.get_db_business(scenario.id)
    if not row:
        return 0
    db_emps = {e.employee_id: e for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    data = rec.get_schedule_data()
    shifts_by_emp = {}
    for a in data.get('assignments', []):
        d = week_start + timedelta(days=int(a['day']))
        line = f"{DAY_NAMES[int(a['day'])]} {d.strftime('%b')} {d.day}: {format_shift_time(a['start_hour'], a['end_hour'])}"
        shifts_by_emp.setdefault(a['employee_id'], []).append(line)

    recipients = []
    for emp in scenario.employees:
        db_emp = db_emps.get(emp.id)
        if not db_emp or not (db_emp.email or db_emp.phone):
            continue
        recipients.append({
            'contact': contact_for(db_emp),
            'employee_db_id': db_emp.id,
            'shifts': shifts_by_emp.get(emp.id, []),
        })
    if recipients:
        notify_schedule_published(scenario.name, business_slug(scenario.name), week_start, recipients)
    return len(recipients)
