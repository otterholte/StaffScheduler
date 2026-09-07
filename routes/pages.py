"""
HTML page routes: marketing pages, the manager app, the demo, the employee portal.

URL scheme
    /                                   landing page
    /pricing /support /contact          marketing
    /app                                jump to "my" place (business, portal, or demo)
    /demo/<page>                        try the app with built-in demo businesses (no login)
    /<business-slug>/<page>             manager app for a business the user owns
    /employee/<slug>/<id>/schedule      employee portal
    /employee/<slug>/<id>/availability  employee availability + time off
    /settings                           account settings + theme
"""

from flask import Blueprint, abort, jsonify, redirect, render_template, request
from flask_login import current_user, login_required

from models import DBEmployee, DBBusiness
from scheduler import DAYS_OF_WEEK, list_demo_businesses, get_demo_business, DEMO_BUSINESS_IDS
from services.business_context import (
    BusinessAccessError, business_slug, db_summary, default_landing_url, ensure_user_has_business,
    find_owned_by_ref, list_owned_businesses, load_scenario, require_employee_access,
    set_current_business_id, summary,
)
from services.common import PAGE_SLUGS, RESERVED_SLUGS, TAB_TO_SLUG

pages_bp = Blueprint('pages', __name__)

APP_VERSION = '2.0.0'


# ---------------------------------------------------------------- marketing

@pages_bp.route('/')
def landing():
    return render_template('features.html', user=current_user)


@pages_bp.route('/features')
def features_page():
    return redirect('/')


@pages_bp.route('/pricing')
def pricing_page():
    return render_template('pricing.html', user=current_user)


@pages_bp.route('/support')
def support_page():
    return render_template('support.html', user=current_user)


@pages_bp.route('/contact')
def contact_page():
    return render_template('contact.html', user=current_user)


@pages_bp.route('/api/health')
def health():
    """Used after deploys to confirm the new build is live."""
    return jsonify({'status': 'ok', 'version': APP_VERSION})


# ---------------------------------------------------------------- entry points

@pages_bp.route('/app')
def app_redirect():
    return redirect(default_landing_url())


@pages_bp.route('/login')
def login_alias():
    return redirect('/auth/login' + (f"?{request.query_string.decode()}" if request.query_string else ''))


@pages_bp.route('/register')
def register_alias():
    return redirect('/auth/register')


@pages_bp.route('/settings')
def settings_page():
    """Account settings. The back link goes to wherever this user normally works."""
    user = current_user if current_user.is_authenticated else None
    back_url = default_landing_url(user) if user else '/demo/schedule'
    return render_template('settings.html', user=user, back_url=back_url)


# ---------------------------------------------------------------- demo

def _render_app(business, businesses, user_businesses_count, page_slug, location_slug, is_demo):
    """Shared renderer for the manager app (real and demo)."""
    return render_template(
        'index.html',
        business=business.to_dict(),
        businesses=businesses,
        user_businesses_count=user_businesses_count,
        employees=[e.to_dict() for e in business.employees],
        roles=[r.to_dict() for r in business.roles],
        days=DAYS_OF_WEEK,
        days_open=business.days_open,
        hours=list(business.get_operating_hours()),
        start_hour=business.start_hour,
        end_hour=business.end_hour,
        initial_tab=PAGE_SLUGS.get(page_slug, 'schedule'),
        initial_page_slug=page_slug,
        location_slug=location_slug,
        page_slugs=PAGE_SLUGS,
        tab_to_slug=TAB_TO_SLUG,
        user=current_user if current_user.is_authenticated else None,
        is_demo=is_demo,
        my_business_url=default_landing_url() if current_user.is_authenticated else None,
    )


@pages_bp.route('/demo')
@pages_bp.route('/demo/<page_slug>')
def demo_page(page_slug='schedule'):
    """Explore the five built-in businesses. Works with or without an account."""
    if page_slug not in PAGE_SLUGS:
        return redirect('/demo/schedule')
    demo_id = request.args.get('business', '')
    if demo_id not in DEMO_BUSINESS_IDS:
        demo_id = 'coffee_shop'
    business = get_demo_business(demo_id)
    set_current_business_id(demo_id)
    businesses = [summary(b) for b in list_demo_businesses()]
    return _render_app(business, businesses, 0, page_slug, business_slug(business.name), is_demo=True)


# ---------------------------------------------------------------- manager app

@pages_bp.route('/<location_slug>/<page_slug>')
@login_required
def app_page(location_slug, page_slug):
    if location_slug in RESERVED_SLUGS:
        abort(404)
    if page_slug not in PAGE_SLUGS:
        return redirect(f'/{location_slug}/schedule')

    # Employee-only accounts go to their portal, not the manager app
    if current_user.linked_employee_id and not current_user.is_manager and not list_owned_businesses():
        return redirect(default_landing_url())

    row = find_owned_by_ref(location_slug)
    if not row:
        # Old demo URLs (e.g. /sunrise-coffee/...) or someone else's slug: go home
        return redirect(default_landing_url())

    set_current_business_id(row.business_id)
    business = load_scenario(row)
    owned = list_owned_businesses()
    businesses = [db_summary(b) for b in owned]
    return _render_app(business, businesses, len(businesses), page_slug, business_slug(row.name), is_demo=False)


@pages_bp.route('/<location_slug>')
def app_page_default(location_slug):
    if location_slug in RESERVED_SLUGS:
        abort(404)
    if not current_user.is_authenticated:
        return redirect(f'/auth/login?next=/{location_slug}/schedule')
    return redirect(f'/{location_slug}/schedule')


# ---------------------------------------------------------------- employee portal

def _portal_context(business, row, db_employee, employee):
    all_employees = []
    db_ids = {e.employee_id: e.id for e in DBEmployee.query.filter_by(business_db_id=row.id).all()}
    for emp in business.employees:
        d = emp.to_dict()
        d['db_id'] = db_ids.get(emp.id)
        all_employees.append(d)
    employee_dict = employee.to_dict()
    employee_dict['db_id'] = db_employee.id
    employee_dict['notify_email'] = True if db_employee.notify_email is None else bool(db_employee.notify_email)
    employee_dict['notify_sms'] = True if db_employee.notify_sms is None else bool(db_employee.notify_sms)
    return dict(
        business=business,
        business_data=business.to_dict(),
        business_slug=business_slug(row.name),
        employee=employee,
        employee_id=db_employee.id,
        employee_data=employee_dict,
        all_employees_data=all_employees,
        roles=business.roles,
        roles_data=[r.to_dict() for r in business.roles],
        days=DAYS_OF_WEEK,
        days_open=business.days_open,
        hours=list(business.get_operating_hours()),
        start_hour=business.start_hour,
        end_hour=business.end_hour,
        is_manager_view=(current_user.linked_employee_id != db_employee.id),
        user=current_user,
    )


def _employee_page(business_slug_in_url, employee_id, template, extra=None):
    try:
        business, row, db_employee = require_employee_access(employee_id)
    except BusinessAccessError as err:
        if err.status == 401:
            return redirect(f'/auth/login?next={request.path}')
        return render_template('403.html', message=str(err)), err.status

    employee = next((e for e in business.employees if e.id == db_employee.employee_id), None)
    if not employee:
        return render_template('403.html', message='This employee no longer exists.'), 404

    # Keep the URL canonical if the business was renamed
    canonical = business_slug(row.name)
    if business_slug_in_url != canonical:
        page = 'availability' if template == 'employee_availability.html' else 'schedule'
        return redirect(f'/employee/{canonical}/{db_employee.id}/{page}')

    ctx = _portal_context(business, row, db_employee, employee)
    if extra:
        ctx.update(extra(employee))
    return render_template(template, **ctx)


@pages_bp.route('/employee/<business_slug>/<int:employee_id>/schedule')
@login_required
def employee_schedule(business_slug, employee_id):
    return _employee_page(business_slug, employee_id, 'employee_schedule.html',
                          extra=lambda emp: {'schedule_data': {}})


@pages_bp.route('/employee/<business_slug>/<int:employee_id>/availability')
@login_required
def employee_availability(business_slug, employee_id):
    def availability_ranges(emp):
        data = {}
        if emp.availability_ranges:
            for r in emp.availability_ranges:
                data.setdefault(r.day, []).append([r.start_time, r.end_time])
        else:
            by_day = {}
            for slot in emp.availability:
                by_day.setdefault(slot.day, []).append(slot.hour)
            for day, hours in by_day.items():
                hours.sort()
                ranges, start, end = [], hours[0], hours[0] + 1
                for h in hours[1:]:
                    if h == end:
                        end = h + 1
                    else:
                        ranges.append([start, end])
                        start, end = h, h + 1
                ranges.append([start, end])
                data[day] = ranges
        return {'availability_data': data}

    return _employee_page(business_slug, employee_id, 'employee_availability.html', extra=availability_ranges)
