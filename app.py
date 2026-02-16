"""
Magic Staff Scheduler - Professional Flask Application

A comprehensive staff scheduling solution with:
- User authentication with PostgreSQL database
- Multiple business scenarios
- Role-based scheduling
- Full CRUD operations for employees and settings
- Soft and hard constraint optimization
"""

from flask import Flask, render_template, jsonify, request, redirect, url_for
from flask_login import LoginManager, login_required, current_user
import uuid
import json
import os
import re
import secrets
import string
from scheduler import (
    AdvancedScheduleSolver,
    get_all_businesses,
    get_business_by_id,
    create_user_business,
    get_user_business,
    DAYS_OF_WEEK
)
from scheduler.businesses import sync_business_to_db, load_businesses_from_db
from db_service import save_schedule_to_db, get_schedule_from_db, get_schedule_with_status_from_db, publish_schedule_in_db, get_published_schedule_from_db
from datetime import date, datetime, timedelta
import threading
from scheduler.models import (
    Employee, Role, TimeSlot, EmployeeClassification,
    PeakPeriod, RoleCoverageConfig, CoverageRequirement,
    CoverageMode, ShiftTemplate, ShiftRoleRequirement
)
from config import get_config
from models import db, bcrypt, User, BusinessSettings, UserBusinessSettings, init_db, ShiftSwapRequest, SwapRequestRecipient, DBSchedule, DBEmployee
from auth import auth_bp
from email_service import get_email_service


def get_site_url():
    """Get the base site URL for external links (emails, etc.).
    
    Uses SITE_URL from config/environment, falling back to request host.
    """
    site_url = app.config.get('SITE_URL')
    if site_url and site_url != 'http://localhost:5000':
        return site_url.rstrip('/')
    # Fall back to request host for local development
    return request.host_url.rstrip('/')


def generate_temp_password(length=10):
    """Generate a random temporary password."""
    # Use letters and digits, avoiding confusing characters like 0/O, 1/l
    alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def create_or_get_employee_user(db_employee, employee_email, employee_name):
    """Create a User account for an employee or return existing one.
    
    Returns:
        tuple: (user, temp_password) - temp_password is None if user already exists
    """
    # Check if user already exists with this email
    existing_user = User.query.filter_by(email=employee_email.lower()).first()
    
    if existing_user:
        # User exists - check if it's linked to this employee
        if existing_user.linked_employee_id == db_employee.id:
            # Already linked to this employee, no new password needed
            return existing_user, None
        elif existing_user.linked_employee_id is None:
            # User exists but not linked to any employee - link them
            existing_user.linked_employee_id = db_employee.id
            db.session.commit()
            return existing_user, None
        else:
            # User is linked to a different employee - this email is already taken
            print(f"[EMPLOYEE_USER] Email {employee_email} is already linked to another employee", flush=True)
            return None, None
    
    # Create new user account for employee
    temp_password = generate_temp_password()
    
    # Generate username from email (before the @)
    base_username = employee_email.split('@')[0].lower()
    # Sanitize username - only allow alphanumeric and underscore
    base_username = re.sub(r'[^a-z0-9_]', '', base_username)
    if len(base_username) < 3:
        base_username = 'employee_' + base_username
    
    # Ensure username is unique
    username = base_username
    counter = 1
    while User.query.filter_by(username=username).first():
        username = f"{base_username}{counter}"
        counter += 1
    
    # Create the user
    new_user = User(
        email=employee_email.lower(),
        username=username,
        first_name=employee_name.split()[0] if employee_name else '',
        last_name=' '.join(employee_name.split()[1:]) if employee_name and len(employee_name.split()) > 1 else '',
        linked_employee_id=db_employee.id,
        must_change_password=True,
        is_active=True,
        is_verified=True  # Consider them verified since manager invited them
    )
    new_user.set_password(temp_password)
    
    db.session.add(new_user)
    db.session.commit()
    
    print(f"[EMPLOYEE_USER] Created user account for {employee_email} (username: {username})", flush=True)
    
    return new_user, temp_password


def create_app():
    """Create and configure the Flask application."""
    app = Flask(__name__)
    
    # Load configuration
    config_class = get_config()
    app.config.from_object(config_class)
    
    # Initialize database
    init_db(app)
    
    # Initialize Flask-Login
    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = 'Please log in to access this page.'
    login_manager.login_message_category = 'info'
    
    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))
    
    # Register authentication blueprint with /auth prefix
    app.register_blueprint(auth_bp, url_prefix='/auth')
    
    return app


app = create_app()


# ==================== ERROR HANDLERS ====================

@app.errorhandler(500)
def internal_error(error):
    """Handle internal server errors with logging."""
    import traceback
    print("=" * 60, flush=True)
    print("[500 ERROR] Internal Server Error", flush=True)
    print(f"Error: {error}", flush=True)
    print(f"URL: {request.url if request else 'Unknown'}", flush=True)
    print(f"Method: {request.method if request else 'Unknown'}", flush=True)
    traceback.print_exc()
    print("=" * 60, flush=True)
    
    # Return a JSON error for API routes, HTML for regular pages
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Internal server error', 'message': str(error)}), 500
    return render_template('features.html', user=None, error_message="Something went wrong. Please try again."), 500


@app.errorhandler(404)
def not_found_error(error):
    """Handle 404 not found errors."""
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Not found', 'message': 'The requested resource was not found'}), 404
    return redirect('/')


@app.errorhandler(Exception)
def handle_exception(error):
    """Handle unexpected exceptions with detailed logging."""
    from werkzeug.exceptions import HTTPException
    
    # Pass through HTTP exceptions to their specific handlers
    if isinstance(error, HTTPException):
        return error
    
    import traceback
    print("=" * 60, flush=True)
    print(f"[UNHANDLED EXCEPTION] {type(error).__name__}", flush=True)
    print(f"Error: {error}", flush=True)
    print(f"URL: {request.url if request else 'Unknown'}", flush=True)
    print(f"Method: {request.method if request else 'Unknown'}", flush=True)
    traceback.print_exc()
    print("=" * 60, flush=True)
    
    # Return a JSON error for API routes, HTML for regular pages
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Server error', 'message': 'An unexpected error occurred'}), 500
    return render_template('features.html', user=None, error_message="Something went wrong. Please try again."), 500


# Prevent browser caching of HTML pages so regular refresh gets fresh data
@app.after_request
def add_cache_control_headers(response):
    """Add cache control headers to prevent browser caching of HTML pages."""
    # Only for HTML responses (not static files like JS/CSS/images)
    if response.content_type and 'text/html' in response.content_type:
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response


# ==================== URL SLUG HELPERS ====================

# Valid page slugs and their internal tab IDs
PAGE_SLUGS = {
    'schedule': 'schedule',
    'staff': 'employees',
    'availability': 'settings',
    'requirements': 'help'
}

# Reverse mapping: tab ID to page slug
TAB_TO_SLUG = {v: k for k, v in PAGE_SLUGS.items()}


@app.route('/settings')
def settings_page():
    """Render the settings page with account management and theme toggle.
    
    Accessible to all users - shows login button for unauthenticated users,
    and account management for authenticated users.
    """
    try:
        user = current_user if current_user.is_authenticated else None
        return render_template('settings.html', user=user)
    except Exception as e:
        import traceback
        print("Error rendering settings.html:", e)
        traceback.print_exc()
        return f"Error rendering settings: {e}", 500


def slugify(text):
    """Convert text to URL-friendly slug."""
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text


def get_business_slug(business_id):
    """Get the slug for a business ID (checking custom names first)."""
    if business_id in _custom_businesses:
        custom_name = _custom_businesses[business_id].get('name')
        if custom_name:
            return slugify(custom_name)
    
    try:
        business = get_business_by_id(business_id)
        return slugify(business.name)
    except ValueError:
        return business_id


def get_business_by_slug(slug, force_reload: bool = False):
    """Find a business by its slug (checking custom names first).
    
    Args:
        slug: The URL slug for the business
        force_reload: If True, bypass cache and reload from database (for employee portal)
    """
    slug = slug.lower()
    
    # For employee portal requests, make sure we refresh from DB (handles multi-worker)
    if force_reload:
        try:
            # Force reload cached businesses from the database
            from scheduler.businesses import load_businesses_from_db
            load_businesses_from_db(force_reload=True)
        except Exception as e:
            print(f"Warning: force_reload failed in get_business_by_slug: {e}")
    
    # Check custom business names first
    for business_id, custom_data in _custom_businesses.items():
        custom_name = custom_data.get('name')
        if custom_name and slugify(custom_name) == slug:
            return get_business_by_id(business_id, force_reload=force_reload)
    
    # Check all businesses by their default names
    for business in get_all_businesses():
        if slugify(business.name) == slug:
            # For user businesses, force reload if requested
            if force_reload and business.id.startswith('user_'):
                return get_business_by_id(business.id, force_reload=True)
            return business
    
    # If still not found and force_reload requested, query DB directly by slug
    if force_reload:
        try:
            from db_service import get_all_persisted_businesses, load_business_from_db
            db_businesses = get_all_persisted_businesses()
            for db_business in db_businesses:
                if slugify(db_business.name) == slug or db_business.business_id == slug:
                    scenario = load_business_from_db(db_business)
                    # Update cache for future requests
                    try:
                        from scheduler.businesses import _business_cache, _user_businesses
                        _business_cache[scenario.id] = scenario
                        _user_businesses[db_business.owner_id] = scenario.id
                    except Exception:
                        pass
                    return scenario
        except Exception as e:
            print(f"Warning: DB slug lookup failed in get_business_by_slug: {e}")
    
    # Finally, try matching directly by ID
    try:
        return get_business_by_id(slug, force_reload=force_reload)
    except ValueError:
        return None

# Global state
_current_business = None
_solver = None

# Custom businesses storage
CUSTOM_BUSINESSES_FILE = 'custom_businesses.json'
_custom_businesses = {}

def load_custom_businesses():
    """Load custom businesses from JSON file."""
    global _custom_businesses
    if os.path.exists(CUSTOM_BUSINESSES_FILE):
        try:
            with open(CUSTOM_BUSINESSES_FILE, 'r') as f:
                _custom_businesses = json.load(f)
        except (json.JSONDecodeError, IOError):
            _custom_businesses = {}
    return _custom_businesses

def save_custom_businesses():
    """Save custom businesses to JSON file."""
    with open(CUSTOM_BUSINESSES_FILE, 'w') as f:
        json.dump(_custom_businesses, f, indent=2)

# Load custom businesses on startup
load_custom_businesses()


def ensure_user_business_exists(user):
    """Ensure a user's business exists in the cache if they have a company_name.
    
    This handles the case where the server restarts and in-memory business cache is cleared.
    """
    if not user or not user.company_name:
        return None
    
    # Check if user's business already exists
    user_business = get_user_business(user.id)
    if user_business:
        return user_business
    
    # Recreate the user's business from their stored company_name
    owner_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    if not owner_name:
        owner_name = user.username
    
    business = create_user_business(user.id, user.company_name, owner_name)
    return business


def get_current_business():
    """Get the currently active business scenario."""
    global _current_business
    if _current_business is None:
        _current_business = get_business_by_id("coffee_shop")
    return _current_business


# Store current policies
_current_policies = {
    'min_shift_length': 2,
    'max_hours_per_day': 8,
    'max_splits': 2,
    'max_split_shifts_per_week': 1,
    'scheduling_strategy': 'balanced',  # 'minimize', 'balanced', 'maximize'
    'max_days_ft': 5,
    'max_days_ft_mode': 'required',
    'max_days_pt': 4,
    'max_days_pt_mode': 'required'
}

def get_solver(policies=None):
    """Get or create the solver for the current business."""
    global _solver, _current_business, _current_policies
    business = get_current_business()
    
    # Update policies if provided
    if policies:
        old_policies = _current_policies.copy()
        _current_policies['min_shift_length'] = policies.get('min_shift_length', _current_policies['min_shift_length'])
        _current_policies['max_hours_per_day'] = policies.get('max_hours_per_day', _current_policies['max_hours_per_day'])
        _current_policies['max_splits'] = policies.get('max_splits', _current_policies['max_splits'])
        _current_policies['max_split_shifts_per_week'] = policies.get('max_split_shifts_per_week', _current_policies['max_split_shifts_per_week'])
        _current_policies['scheduling_strategy'] = policies.get('scheduling_strategy', _current_policies['scheduling_strategy'])
        _current_policies['max_days_ft'] = policies.get('max_days_ft', _current_policies['max_days_ft'])
        _current_policies['max_days_ft_mode'] = policies.get('max_days_ft_mode', _current_policies['max_days_ft_mode'])
        _current_policies['max_days_pt'] = policies.get('max_days_pt', _current_policies['max_days_pt'])
        _current_policies['max_days_pt_mode'] = policies.get('max_days_pt_mode', _current_policies['max_days_pt_mode'])
        
        # Force recreation if any policy changed
        if old_policies != _current_policies:
            _solver = None
    
    if _solver is None or _current_business != business:
        _solver = AdvancedScheduleSolver(
            business=business,
            min_shift_hours=_current_policies['min_shift_length'],
            max_hours_per_day=_current_policies['max_hours_per_day'],
            max_splits_per_day=_current_policies['max_splits'],
            max_split_shifts_per_week=_current_policies['max_split_shifts_per_week'],
            scheduling_strategy=_current_policies['scheduling_strategy'],
            max_days_ft=_current_policies['max_days_ft'],
            max_days_ft_mode=_current_policies['max_days_ft_mode'],
            max_days_pt=_current_policies['max_days_pt'],
            max_days_pt_mode=_current_policies['max_days_pt_mode']
        )
    return _solver


# ==================== PAGE ROUTES ====================

@app.route('/')
def landing():
    """Show the features/landing page."""
    return render_template('features.html', user=current_user)


@app.route('/app')
def app_redirect():
    """Redirect to the main app - authenticated users go to their dashboard, others to demo."""
    if current_user.is_authenticated:
        business = get_current_business()
        location_slug = get_business_slug(business.id)
        return redirect(f'/{location_slug}/schedule')
    return redirect('/demo/schedule')


@app.route('/demo')
@app.route('/demo/<page_slug>')
def demo_page(page_slug='schedule'):
    """Demo mode - allows non-authenticated users to explore the app."""
    # If user is authenticated, redirect to their actual dashboard
    if current_user.is_authenticated:
        business = get_current_business()
        location_slug = get_business_slug(business.id)
        return redirect(f'/{location_slug}/{page_slug}')
    
    # Validate page slug
    if page_slug not in PAGE_SLUGS:
        return redirect('/demo/schedule')
    
    # Use the coffee shop as the demo business
    all_businesses = get_all_businesses()
    demo_business = None
    for b in all_businesses:
        if b.id == 'coffee_shop':
            demo_business = b
            break
    if not demo_business:
        demo_business = all_businesses[0] if all_businesses else None
    
    if not demo_business:
        return redirect('/features')
    
    # Build business list for demo - only show the 5 demo businesses
    DEMO_BUSINESS_IDS = {'coffee_shop', 'retail_store', 'restaurant', 'call_center', 'warehouse'}
    businesses_data = []
    business_meta = {
        'coffee_shop': {'emoji': '☕', 'color': '#3b82f6'},
        'retail_store': {'emoji': '👗', 'color': '#f59e0b'},
        'restaurant': {'emoji': '🍽️', 'color': '#ef4444'},
        'call_center': {'emoji': '💻', 'color': '#4b5563'},
        'warehouse': {'emoji': '📦', 'color': '#8b5cf6'}
    }
    
    for b in all_businesses:
        # Only include demo businesses for non-authenticated users
        if b.id not in DEMO_BUSINESS_IDS:
            continue
        meta = business_meta.get(b.id, {'emoji': '🏢', 'color': '#6366f1'})
        businesses_data.append({
            "id": b.id,
            "name": b.name,
            "slug": get_business_slug(b.id),
            "description": b.description,
            "total_employees": len(b.employees),
            "total_roles": len(b.roles),
            "emoji": meta['emoji'],
            "color": meta['color']
        })
    
    initial_tab = PAGE_SLUGS.get(page_slug, 'schedule')
    demo_slug = get_business_slug(demo_business.id)
    
    return render_template(
        'index.html',
        business=demo_business.to_dict(),
        businesses=businesses_data,
        user_businesses_count=0,  # No user businesses in demo mode
        employees=[emp.to_dict() for emp in demo_business.employees],
        roles=[r.to_dict() for r in demo_business.roles],
        days=DAYS_OF_WEEK,
        days_open=demo_business.days_open,
        hours=list(demo_business.get_operating_hours()),
        start_hour=demo_business.start_hour,
        end_hour=demo_business.end_hour,
        initial_tab=initial_tab,
        initial_page_slug=page_slug,
        location_slug=demo_slug,
        page_slugs=PAGE_SLUGS,
        tab_to_slug=TAB_TO_SLUG,
        user=None,  # No user in demo mode
        is_demo=True  # Flag for demo mode
    )


@app.route('/<location_slug>/<page_slug>')
@login_required
def app_page(location_slug, page_slug):
    """Render the main app with specified location and page (manager view)."""
    global _current_business, _solver
    
    # Exclude reserved prefixes - these are handled by other routes
    if location_slug in ('api', 'auth', 'employee', 'static', 'demo'):
        from flask import abort
        abort(404)
    
    # Ensure user's business exists if they have one (in case server restarted)
    ensure_user_business_exists(current_user)
    
    # Force reload businesses from database to ensure we have the latest
    load_businesses_from_db(force_reload=True)
    
    # Validate page slug
    if page_slug not in PAGE_SLUGS:
        # Try to redirect to schedule for this location
        return redirect(f'/{location_slug}/schedule')
    
    # Find business by slug - force reload from DB to ensure fresh data
    # (important for multi-worker environments like Railway/Gunicorn)
    business = get_business_by_slug(location_slug, force_reload=True)
    if not business:
        # Business not found, redirect to default
        default_business = get_current_business()
        location_slug = get_business_slug(default_business.id)
        return redirect(f'/{location_slug}/{page_slug}')
    
    # Built-in demo business IDs - accessible to all authenticated users
    DEMO_BUSINESS_IDS = {'coffee_shop', 'retail_store', 'restaurant', 'call_center', 'warehouse'}
    
    # Authorization check: user must own the business OR it must be a demo business
    is_demo_business = business.id in DEMO_BUSINESS_IDS
    is_business_owner = business.id.startswith(f'user_{current_user.id}_')
    
    if not is_demo_business and not is_business_owner:
        return render_template('403.html', message="You don't have permission to manage this business."), 403
    
    # Set this as the current business
    if _current_business is None or _current_business.id != business.id:
        _current_business = business
        _solver = None  # Reset solver when business changes
    
    businesses = get_all_businesses()
    
    # Default emoji/color mapping for built-in businesses
    business_meta = {
        'coffee_shop': {'emoji': '☕', 'color': '#3b82f6'},
        'retail_store': {'emoji': '👗', 'color': '#f59e0b'},
        'restaurant': {'emoji': '🍽️', 'color': '#ef4444'},
        'call_center': {'emoji': '💻', 'color': '#4b5563'},
        'warehouse': {'emoji': '📦', 'color': '#8b5cf6'}
    }
    
    # Helper function to build business data
    def build_business_data(b):
        meta = business_meta.get(b.id, {'emoji': '🏢', 'color': '#6366f1'})
        # Apply custom metadata if exists
        if b.id in _custom_businesses:
            meta = {
                'emoji': _custom_businesses[b.id].get('emoji', meta['emoji']),
                'color': _custom_businesses[b.id].get('color', meta['color'])
            }
            name = _custom_businesses[b.id].get('name', b.name)
        else:
            name = b.name
        return {
            "id": b.id,
            "name": name,
            "slug": get_business_slug(b.id),
            "description": b.description,
            "total_employees": len(b.employees),
            "total_roles": len(b.roles),
            "emoji": meta['emoji'],
            "color": meta['color']
        }
    
    # Separate businesses into user businesses and demo businesses
    user_businesses_data = []
    demo_businesses_data = []
    
    # Get the current user's ID for checking ownership
    user_id = current_user.id if current_user.is_authenticated else None
    
    for b in businesses:
        if b.id in DEMO_BUSINESS_IDS:
            # Demo business
            demo_businesses_data.append(build_business_data(b))
        else:
            # User business - check if user owns it or is an employee
            is_owner = b.id.startswith(f'user_{user_id}_') if user_id else False
            is_employee = any(
                emp.email and current_user.is_authenticated and emp.email.lower() == current_user.email.lower()
                for emp in b.employees
            ) if current_user.is_authenticated else False
            
            if is_owner or is_employee:
                user_businesses_data.append(build_business_data(b))
    
    # Combine: user businesses first, then demo businesses
    businesses_data = user_businesses_data + demo_businesses_data
    
    # Get the internal tab ID for the page
    initial_tab = PAGE_SLUGS.get(page_slug, 'schedule')
    
    # Pass user if authenticated, None otherwise
    user = current_user if current_user.is_authenticated else None
    
    return render_template(
        'index.html',
        business=business.to_dict(),
        businesses=businesses_data,
        user_businesses_count=len(user_businesses_data),
        employees=[emp.to_dict() for emp in business.employees],
        roles=[r.to_dict() for r in business.roles],
        days=DAYS_OF_WEEK,
        days_open=business.days_open,
        hours=list(business.get_operating_hours()),
        start_hour=business.start_hour,
        end_hour=business.end_hour,
        initial_tab=initial_tab,
        initial_page_slug=page_slug,
        location_slug=location_slug,
        page_slugs=PAGE_SLUGS,
        tab_to_slug=TAB_TO_SLUG,
        user=user,
        is_demo=False
    )


@app.route('/<location_slug>')
def app_page_default(location_slug):
    """Redirect to schedule page for a location."""
    # Exclude reserved prefixes - these are handled by other routes
    if location_slug in ('api', 'auth', 'employee', 'static', 'demo'):
        from flask import abort
        abort(404)
    
    # Ensure user's business exists if they have one (in case server restarted)
    if current_user.is_authenticated:
        ensure_user_business_exists(current_user)
    
    # Check if it's a valid business
    business = get_business_by_slug(location_slug)
    if not business:
        # Not a valid business, redirect to default
        default_business = get_current_business()
        location_slug = get_business_slug(default_business.id)
    
    return redirect(f'/{location_slug}/schedule')


# ==================== MARKETING PAGES ====================

@app.route('/features')
def features_page():
    """Redirect to landing page (features is now at /)."""
    return redirect('/')


@app.route('/pricing')
def pricing_page():
    """Render the pricing page."""
    return render_template('pricing.html', user=current_user)


@app.route('/support')
def support_page():
    """Render the support page."""
    return render_template('support.html', user=current_user)


@app.route('/contact')
def contact_page():
    """Render the contact page."""
    return render_template('contact.html', user=current_user)


# ==================== EMPLOYEE PORTAL ====================

@app.route('/employee/<business_slug>/<int:employee_id>/schedule')
@login_required
def employee_schedule(business_slug, employee_id):
    """Employee schedule view - read-only view of their shifts."""
    # Force reload from database to ensure we have latest employee data
    # (important for multi-worker environments like Railway/Gunicorn)
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return redirect('/')
    
    # Find the employee by database ID
    # The employee_id in URL is the DBEmployee.id (integer), not the model string ID
    db_employee = DBEmployee.query.get(employee_id)
    if not db_employee:
        return jsonify({
            'success': False,
            'message': f"Employee not found for {business_slug}",
            'employee_id': employee_id
        }), 404
    
    # Authorization check: user must be the employee OR the business manager
    is_the_employee = (current_user.linked_employee_id == employee_id)
    is_business_manager = (current_user.is_manager and business.id.startswith(f'user_{current_user.id}_'))
    
    if not is_the_employee and not is_business_manager:
        return render_template('403.html', message="You don't have permission to view this employee's schedule."), 403
    
    # Find the matching Employee model object using the employee_id string
    employee = None
    for emp in business.employees:
        if emp.id == db_employee.employee_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': f"Employee model not found for {business_slug}",
            'employee_id': employee_id,
            'db_employee_id': db_employee.employee_id
        }), 404
    
    # Get schedule data (if any exists for this week)
    schedule_data = {}  # Will be populated by JS from localStorage or API
    
    # Create employee data with DB ID for URL generation
    employee_dict = employee.to_dict()
    employee_dict['db_id'] = employee_id  # Add DB ID for API calls
    
    # Get all employees data with DB IDs for consistent lookups
    all_employees_data = []
    for emp in business.employees:
        emp_dict = emp.to_dict()
        db_emp = DBEmployee.query.filter_by(employee_id=emp.id).first()
        if db_emp:
            emp_dict['db_id'] = db_emp.id
        all_employees_data.append(emp_dict)
    
    return render_template('employee_schedule.html',
        business=business,
        business_data=business.to_dict(),
        business_slug=business_slug,
        employee=employee,
        employee_id=employee_id,  # Pass DB ID separately
        employee_data=employee_dict,
        all_employees_data=all_employees_data,
        roles=business.roles,
        roles_data=[r.to_dict() for r in business.roles],
        days=DAYS_OF_WEEK,
        days_open=business.days_open,
        hours=list(business.get_operating_hours()),
        start_hour=business.start_hour,
        end_hour=business.end_hour,
        schedule_data=schedule_data
    )


@app.route('/employee/<business_slug>/<int:employee_id>/availability')
@login_required
def employee_availability(business_slug, employee_id):
    """Employee availability editor - edit their own availability."""
    import traceback
    print(f"\n[DEBUG] employee_availability called: business_slug={business_slug}, employee_id={employee_id}")
    
    try:
        # Force reload from database to ensure we have latest employee data
        print(f"[DEBUG] Getting business by slug: {business_slug}")
        business = get_business_by_slug(business_slug, force_reload=True)
        if not business:
            print(f"[DEBUG] Business not found for slug: {business_slug}")
            return redirect('/')
        print(f"[DEBUG] Business found: {business.name}, id={business.id}")
        
        # Find the employee by database ID
        print(f"[DEBUG] Looking up DBEmployee with id={employee_id}")
        db_employee = DBEmployee.query.get(employee_id)
        if not db_employee:
            print(f"[DEBUG] DBEmployee not found for id={employee_id}")
            return redirect('/')
        print(f"[DEBUG] DBEmployee found: name={db_employee.name}, employee_id={db_employee.employee_id}")
        
        # Authorization check: user must be the employee OR the business manager
        is_the_employee = (current_user.linked_employee_id == employee_id)
        is_business_manager = (current_user.is_manager and business.id.startswith(f'user_{current_user.id}_'))
        
        if not is_the_employee and not is_business_manager:
            return render_template('403.html', message="You don't have permission to edit this employee's availability."), 403
        
        # Find the matching Employee model object
        print(f"[DEBUG] Searching for Employee model with id={db_employee.employee_id} among {len(business.employees)} employees")
        employee = None
        for emp in business.employees:
            print(f"[DEBUG]   Checking emp.id={emp.id}")
            if emp.id == db_employee.employee_id:
                employee = emp
                print(f"[DEBUG]   MATCH FOUND!")
                break
        
        if not employee:
            print(f"[DEBUG] Employee model not found! Available IDs: {[e.id for e in business.employees]}")
            return redirect('/')
        print(f"[DEBUG] Employee model found: {employee.name}")
        
        # Get availability data - use availability_ranges if available (preserves 15-min precision)
        availability_data = {}
        print(f"[DEBUG employee_avail] employee.availability_ranges count: {len(employee.availability_ranges) if hasattr(employee, 'availability_ranges') and employee.availability_ranges else 0}")
        print(f"[DEBUG employee_avail] employee.availability_ranges raw: {[r.to_dict() for r in employee.availability_ranges] if hasattr(employee, 'availability_ranges') and employee.availability_ranges else 'None'}")
        
        if hasattr(employee, 'availability_ranges') and employee.availability_ranges:
            # Use the new range-based format with 15-minute precision
            for r in employee.availability_ranges:
                if r.day not in availability_data:
                    availability_data[r.day] = []
                availability_data[r.day].append([r.start_time, r.end_time])
                print(f"[DEBUG employee_avail] Added range: day={r.day}, start={r.start_time}, end={r.end_time}")
        elif hasattr(employee, 'availability') and employee.availability:
            # Fall back to converting from slot-based availability
            print(f"[DEBUG employee_avail] FALLBACK: Using slot-based availability (no ranges found)")
            from collections import defaultdict
            day_hours = defaultdict(list)
            for slot in employee.availability:
                day_hours[slot.day].append(slot.hour)
            
            # Convert to ranges
            for day, hours in day_hours.items():
                hours = sorted(hours)
                ranges = []
                if hours:
                    start = hours[0]
                    end = hours[0] + 1
                    for h in hours[1:]:
                        if h == end:
                            end = h + 1
                        else:
                            ranges.append([start, end])
                            start = h
                            end = h + 1
                    ranges.append([start, end])
                availability_data[day] = ranges
        
        print(f"[DEBUG employee_avail] Final availability_data: {availability_data}")
        
        # Build employee_data with db_id for API calls
        employee_data = employee.to_dict()
        employee_data['db_id'] = employee_id  # Add database ID for PTO API calls
        
        return render_template('employee_availability.html',
            business=business,
            business_data=business.to_dict(),
            business_slug=business_slug,
            employee=employee,
            employee_id=employee_id,  # Pass DB ID for URL generation
            employee_data=employee_data,
            roles=business.roles,
            roles_data=[r.to_dict() for r in business.roles],
            days=DAYS_OF_WEEK,
            days_open=business.days_open,
            hours=list(business.get_operating_hours()),
            start_hour=business.start_hour,
            end_hour=business.end_hour,
            availability_data=availability_data
        )
    except Exception as e:
        print(f"[ERROR] employee_availability crashed: {e}")
        traceback.print_exc()
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500


def deduplicate_slot_assignments(slot_assignments):
    """Remove duplicate employee entries from slot assignments.
    
    Each slot (day,hour) should have at most one assignment per employee.
    Keeps the first occurrence (which may have the original role).
    """
    cleaned = {}
    for key, assignments in slot_assignments.items():
        seen_employees = set()
        unique_assignments = []
        for a in assignments:
            if isinstance(a, dict):
                emp_id = a.get('employee_id')
            elif isinstance(a, (list, tuple)):
                emp_id = a[0]
            else:
                unique_assignments.append(a)
                continue
            
            if emp_id not in seen_employees:
                seen_employees.add(emp_id)
                unique_assignments.append(a)
        cleaned[key] = unique_assignments
    return cleaned


@app.route('/api/employee/<business_slug>/<int:employee_id>/schedule', methods=['GET'])
def get_employee_schedule(business_slug, employee_id):
    """Get the published schedule for an employee (no login required - public for employees)."""
    # Prefer explicit weekStart date from client (avoids timezone mismatch between client/server)
    week_start_str = request.args.get('weekStart')
    
    # Get the business - force reload to ensure fresh employee data
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return jsonify({
            'success': False,
            'message': 'Business not found'
        }), 404
    
    # Get the published schedule from database
    if week_start_str:
        try:
            week_start = date.fromisoformat(week_start_str)
        except ValueError:
            week_start = get_week_start(request.args.get('weekOffset', 0, type=int))
    else:
        week_start = get_week_start(request.args.get('weekOffset', 0, type=int))
    
    try:
        schedule = get_published_schedule_from_db(business.id, week_start)
        if schedule:
            # Filter assignments for this employee
            employee_shifts = [
                a.to_dict() for a in schedule.assignments 
                if a.employee_id == employee_id
            ]
            # Deduplicate slot_assignments to fix any corruption from previous swap bugs
            raw_slot_assignments = schedule.to_dict().get('slot_assignments', {})
            slot_assignments = deduplicate_slot_assignments(raw_slot_assignments)
            
            return jsonify({
                'success': True,
                'schedule': {
                    'assignments': [a.to_dict() for a in schedule.assignments],
                    'slot_assignments': slot_assignments,
                    'employee_shifts': employee_shifts
                },
                'week_start': week_start.isoformat(),
                'published': True
            })
        else:
            return jsonify({
                'success': False,
                'message': 'No published schedule for this week',
                'published': False
            })
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'Failed to load schedule: {str(e)}'
        }), 500


@app.route('/api/employee/<int:employee_id>/availability', methods=['PUT'])
def employee_update_availability(employee_id):
    """Employee API to update their own availability with 15-minute precision.
    
    Accepts range format: {"availability": {"0": [[9, 17], [18.5, 21]], ...}}
    Times are decimal hours (9.25 = 9:15 AM, 17.5 = 5:30 PM).
    """
    global _solver
    data = request.json
    business_id = data.get('business_id')
    new_availability = data.get('availability', {})
    
    # Find the business
    try:
        business = get_business_by_id(business_id)
    except ValueError:
        return jsonify({'success': False, 'error': 'Business not found'}), 404
    
    # Look up DB employee to get the model ID
    db_employee = DBEmployee.query.get(employee_id)
    if not db_employee:
        return jsonify({'success': False, 'error': 'Employee not found in database'}), 404
    
    # Find the employee model using the model ID from DB record
    employee = None
    for emp in business.employees:
        if emp.id == db_employee.employee_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({'success': False, 'error': 'Employee not found in business'}), 404
    
    # Clear existing availability (both ranges and slots)
    employee.clear_availability()
    
    # Add new availability with 15-minute precision
    for day_str, ranges in new_availability.items():
        day = int(day_str)
        for start, end in ranges:
            employee.add_availability(day, float(start), float(end))
    
    # Reset solver since availability changed
    _solver = None
    
    # Return the availability ranges (preserving 15-min precision)
    avail_data = {}
    for r in employee.availability_ranges:
        if r.day not in avail_data:
            avail_data[r.day] = []
        avail_data[r.day].append([r.start_time, r.end_time])
    
    # Sync to database for persistence (get owner_id from DB)
    try:
        from db_service import get_db_business
        db_business = get_db_business(business_id)
        if db_business:
            sync_business_to_db(business_id, db_business.owner_id)
    except Exception as e:
        print(f"Warning: Could not sync availability to database: {e}")
    
    return jsonify({
        'success': True,
        'message': 'Availability updated',
        'availability': avail_data
    })


# ==================== PTO REQUEST ENDPOINTS ====================

@app.route('/api/employee/<business_slug>/<int:employee_id>/pto', methods=['GET'])
def get_employee_pto_requests(business_slug, employee_id):
    """Get all PTO requests for an employee."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        # Find the employee to get their string ID
        from db_service import get_db_business
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        # Find the employee in the database
        from models import DBEmployee, PTORequest
        db_employee = DBEmployee.query.filter_by(
            business_db_id=db_business.id,
            id=employee_id
        ).first()
        
        if not db_employee:
            return jsonify({'success': False, 'error': 'Employee not found'}), 404
        
        # Get all PTO requests for this employee
        pto_requests = PTORequest.query.filter_by(
            business_db_id=db_business.id,
            employee_id=db_employee.employee_id
        ).order_by(PTORequest.start_date.desc()).all()
        
        return jsonify({
            'success': True,
            'pto_requests': [req.to_dict() for req in pto_requests]
        })
    except Exception as e:
        import traceback
        print(f"Error getting PTO requests: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/employee/<business_slug>/<int:employee_id>/pto', methods=['POST'])
def create_employee_pto_request(business_slug, employee_id):
    """Create a new PTO request for an employee."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import DBEmployee, PTORequest
        from datetime import datetime
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        # Find the employee in the database
        db_employee = DBEmployee.query.filter_by(
            business_db_id=db_business.id,
            id=employee_id
        ).first()
        
        if not db_employee:
            return jsonify({'success': False, 'error': 'Employee not found'}), 404
        
        data = request.json
        start_date_str = data.get('start_date')
        end_date_str = data.get('end_date', start_date_str)  # Default to single day
        pto_type = data.get('pto_type', 'vacation')
        employee_note = data.get('note', '')
        
        if not start_date_str:
            return jsonify({'success': False, 'error': 'Start date is required'}), 400
        
        # Parse dates
        start_date = datetime.strptime(start_date_str, '%Y-%m-%d').date()
        end_date = datetime.strptime(end_date_str, '%Y-%m-%d').date()
        
        if end_date < start_date:
            return jsonify({'success': False, 'error': 'End date cannot be before start date'}), 400
        
        # Create the PTO request
        pto_request = PTORequest(
            business_db_id=db_business.id,
            employee_id=db_employee.employee_id,
            start_date=start_date,
            end_date=end_date,
            pto_type=pto_type,
            employee_note=employee_note,
            status='pending'
        )
        
        db.session.add(pto_request)
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'PTO request submitted',
            'pto_request': pto_request.to_dict()
        })
    except Exception as e:
        import traceback
        print(f"Error creating PTO request: {e}")
        traceback.print_exc()
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/employee/<business_slug>/<int:employee_id>/pto/<request_id>', methods=['DELETE'])
def cancel_employee_pto_request(business_slug, employee_id, request_id):
    """Cancel a pending PTO request."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import DBEmployee, PTORequest
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        # Find the employee
        db_employee = DBEmployee.query.filter_by(
            business_db_id=db_business.id,
            id=employee_id
        ).first()
        
        if not db_employee:
            return jsonify({'success': False, 'error': 'Employee not found'}), 404
        
        # Find the PTO request
        pto_request = PTORequest.query.filter_by(
            request_id=request_id,
            business_db_id=db_business.id,
            employee_id=db_employee.employee_id
        ).first()
        
        if not pto_request:
            return jsonify({'success': False, 'error': 'PTO request not found'}), 404
        
        if pto_request.status != 'pending':
            return jsonify({'success': False, 'error': 'Can only cancel pending requests'}), 400
        
        pto_request.status = 'cancelled'
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'PTO request cancelled'
        })
    except Exception as e:
        import traceback
        print(f"Error cancelling PTO request: {e}")
        traceback.print_exc()
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/<business_slug>/pto', methods=['GET'])
@login_required
def get_business_pto_requests(business_slug):
    """Get all PTO requests for a business (manager view)."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import PTORequest, DBEmployee
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        # Get filter parameters
        status_filter = request.args.get('status')  # 'pending', 'approved', 'denied', etc.
        employee_id_filter = request.args.get('employee_id')
        
        query = PTORequest.query.filter_by(business_db_id=db_business.id)
        
        if status_filter:
            query = query.filter_by(status=status_filter)
        if employee_id_filter:
            query = query.filter_by(employee_id=employee_id_filter)
        
        pto_requests = query.order_by(PTORequest.created_at.desc()).all()
        
        # Enrich with employee names
        result = []
        for req in pto_requests:
            req_dict = req.to_dict()
            # Find employee name
            db_emp = DBEmployee.query.filter_by(
                business_db_id=db_business.id,
                employee_id=req.employee_id
            ).first()
            req_dict['employee_name'] = db_emp.name if db_emp else 'Unknown'
            req_dict['employee_color'] = db_emp.color if db_emp else '#888888'
            result.append(req_dict)
        
        return jsonify({
            'success': True,
            'pto_requests': result
        })
    except Exception as e:
        import traceback
        print(f"Error getting business PTO requests: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/<business_slug>/pto/pending/count', methods=['GET'])
@login_required
def get_pending_pto_count(business_slug):
    """Get count of pending PTO requests for badge display."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import PTORequest
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        count = PTORequest.query.filter_by(
            business_db_id=db_business.id,
            status='pending'
        ).count()
        
        return jsonify({
            'success': True,
            'count': count
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/<business_slug>/pto/<request_id>/approve', methods=['PUT'])
@login_required
def approve_pto_request(business_slug, request_id):
    """Approve a PTO request and remove any conflicting scheduled shifts."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import PTORequest, DBSchedule, DBShiftAssignment
        from datetime import datetime
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        pto_request = PTORequest.query.filter_by(
            request_id=request_id,
            business_db_id=db_business.id
        ).first()
        
        if not pto_request:
            return jsonify({'success': False, 'error': 'PTO request not found'}), 404
        
        if pto_request.status != 'pending':
            return jsonify({'success': False, 'error': 'Request has already been processed'}), 400
        
        # Find and remove conflicting shifts from any schedules
        affected_shifts = []
        
        # Get the date range for the time off
        pto_start = pto_request.start_date
        pto_end = pto_request.end_date
        employee_id = pto_request.employee_id
        
        # Find schedules that overlap with this time off period
        # We need to check schedules where the week overlaps with the PTO dates
        schedules = DBSchedule.query.filter_by(business_db_id=db_business.id).all()
        
        for schedule in schedules:
            week_start = schedule.week_start_date
            week_end = week_start + timedelta(days=6)
            
            # Check if this schedule's week overlaps with the PTO
            if week_start <= pto_end and week_end >= pto_start:
                # Find shift assignments for this employee in this schedule
                shifts_to_remove = DBShiftAssignment.query.filter_by(
                    schedule_id=schedule.id,
                    employee_id=employee_id
                ).all()
                
                for shift in shifts_to_remove:
                    # Convert shift day (0-6) to actual date
                    shift_date = week_start + timedelta(days=shift.day)
                    
                    # Check if this shift falls within the PTO dates
                    if pto_start <= shift_date <= pto_end:
                        affected_shifts.append({
                            'week_id': schedule.week_id,
                            'day': shift.day,
                            'date': shift_date.isoformat(),
                            'start_hour': shift.start_hour,
                            'end_hour': shift.end_hour,
                            'role_id': shift.role_id
                        })
                        
                        # Remove the shift from the schedule
                        db.session.delete(shift)
                
                # If we removed shifts, update the schedule JSON as well
                if affected_shifts:
                    schedule_data = schedule.get_schedule_data()
                    if 'assignments' in schedule_data:
                        # Filter out assignments for this employee on affected days
                        affected_days = {s['day'] for s in affected_shifts if s['week_id'] == schedule.week_id}
                        schedule_data['assignments'] = [
                            a for a in schedule_data['assignments']
                            if not (a.get('employee_id') == employee_id and a.get('day') in affected_days)
                        ]
                        schedule.set_schedule_data(schedule_data)
        
        # Approve the request
        pto_request.status = 'approved'
        pto_request.reviewed_by_id = current_user.id
        pto_request.reviewed_at = datetime.utcnow()
        
        data = request.json or {}
        if data.get('note'):
            pto_request.manager_note = data['note']
        
        db.session.commit()
        
        # Get employee name for the response
        employee_name = employee_id
        for emp in business.employees:
            if emp.id == employee_id:
                employee_name = emp.name
                break
        
        # Build response message
        message = 'Time off request approved'
        if affected_shifts:
            message = f'Time off approved. {len(affected_shifts)} scheduled shift(s) for {employee_name} have been removed and marked as open.'
        
        return jsonify({
            'success': True,
            'message': message,
            'pto_request': pto_request.to_dict(),
            'affected_shifts': affected_shifts,
            'shifts_removed': len(affected_shifts)
        })
    except Exception as e:
        import traceback
        print(f"Error approving PTO request: {e}")
        traceback.print_exc()
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/<business_slug>/pto/<request_id>/deny', methods=['PUT'])
@login_required
def deny_pto_request(business_slug, request_id):
    """Deny a PTO request."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import PTORequest
        from datetime import datetime
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        pto_request = PTORequest.query.filter_by(
            request_id=request_id,
            business_db_id=db_business.id
        ).first()
        
        if not pto_request:
            return jsonify({'success': False, 'error': 'PTO request not found'}), 404
        
        if pto_request.status != 'pending':
            return jsonify({'success': False, 'error': 'Request has already been processed'}), 400
        
        pto_request.status = 'denied'
        pto_request.reviewed_by_id = current_user.id
        pto_request.reviewed_at = datetime.utcnow()
        
        data = request.json or {}
        if data.get('note'):
            pto_request.manager_note = data['note']
        
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'PTO request denied',
            'pto_request': pto_request.to_dict()
        })
    except Exception as e:
        import traceback
        print(f"Error denying PTO request: {e}")
        traceback.print_exc()
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/<business_slug>/pto/approved', methods=['GET'])
def get_approved_pto_for_week(business_slug):
    """Get approved PTO for a specific week (for schedule display)."""
    try:
        business = get_business_by_slug(business_slug)
        if not business:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
        
        from db_service import get_db_business
        from models import PTORequest, DBEmployee
        from datetime import datetime, timedelta
        
        db_business = get_db_business(business.id)
        if not db_business:
            return jsonify({'success': False, 'error': 'Business not found in database'}), 404
        
        # Prefer explicit weekStart date from client (avoids timezone mismatch)
        week_start_str = request.args.get('weekStart')
        if week_start_str:
            try:
                week_monday = date.fromisoformat(week_start_str)
                # Convert Monday-based start to Sunday-based for PTO overlap check
                week_start = week_monday - timedelta(days=1)  # Sunday before
                week_end = week_monday + timedelta(days=6)  # Saturday after
            except ValueError:
                week_offset = request.args.get('weekOffset', 0, type=int)
                today = datetime.now().date()
                days_since_sunday = today.weekday() + 1 if today.weekday() != 6 else 0
                week_start = today - timedelta(days=days_since_sunday) + timedelta(weeks=week_offset)
                week_end = week_start + timedelta(days=6)
        else:
            week_offset = request.args.get('weekOffset', 0, type=int)
            today = datetime.now().date()
            days_since_sunday = today.weekday() + 1 if today.weekday() != 6 else 0
            week_start = today - timedelta(days=days_since_sunday) + timedelta(weeks=week_offset)
            week_end = week_start + timedelta(days=6)
        
        # Get approved PTO that overlaps with this week
        pto_requests = PTORequest.query.filter(
            PTORequest.business_db_id == db_business.id,
            PTORequest.status == 'approved',
            PTORequest.start_date <= week_end,
            PTORequest.end_date >= week_start
        ).all()
        
        # Enrich with employee info
        result = []
        for req in pto_requests:
            req_dict = req.to_dict()
            db_emp = DBEmployee.query.filter_by(
                business_db_id=db_business.id,
                employee_id=req.employee_id
            ).first()
            req_dict['employee_name'] = db_emp.name if db_emp else 'Unknown'
            req_dict['employee_color'] = db_emp.color if db_emp else '#888888'
            req_dict['employee_db_id'] = db_emp.id if db_emp else None
            result.append(req_dict)
        
        return jsonify({
            'success': True,
            'week_start': week_start.isoformat(),
            'week_end': week_end.isoformat(),
            'approved_pto': result
        })
    except Exception as e:
        import traceback
        print(f"Error getting approved PTO: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


# ==================== DATABASE MIGRATION ====================

@app.route('/api/admin/migrate-open-for-swaps')
def migrate_open_for_swaps():
    """One-time migration to add open_for_swaps column to shift_swap_requests table."""
    try:
        from sqlalchemy import text
        
        result = db.session.execute(text("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'shift_swap_requests' AND column_name = 'open_for_swaps'
        """))
        exists = result.fetchone() is not None
        
        if exists:
            return jsonify({
                'success': True,
                'message': 'open_for_swaps column already exists'
            })
        
        db.session.execute(text("""
            ALTER TABLE shift_swap_requests 
            ADD COLUMN open_for_swaps BOOLEAN DEFAULT FALSE
        """))
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Successfully added open_for_swaps column'
        })
    except Exception as e:
        import traceback
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/admin/migrate-swap-columns')
def migrate_swap_columns():
    """One-time migration to add missing columns to shift_swap_requests table."""
    try:
        from sqlalchemy import text
        
        # Check if columns exist first
        result = db.session.execute(text("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'shift_swap_requests' AND column_name = 'counter_offer_for_id'
        """))
        exists = result.fetchone() is not None
        
        if exists:
            return jsonify({
                'success': True,
                'message': 'Columns already exist, no migration needed'
            })
        
        # Add the missing columns
        db.session.execute(text("""
            ALTER TABLE shift_swap_requests 
            ADD COLUMN IF NOT EXISTS counter_offer_for_id INTEGER REFERENCES shift_swap_requests(id),
            ADD COLUMN IF NOT EXISTS is_counter_offer BOOLEAN DEFAULT FALSE
        """))
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Successfully added counter_offer_for_id and is_counter_offer columns'
        })
    except Exception as e:
        import traceback
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


# ==================== DEBUG ENDPOINT ====================

@app.route('/api/debug/<business_slug>/<int:employee_id>')
def debug_employee_info(business_slug, employee_id):
    """Debug endpoint to diagnose employee/business lookup issues."""
    import traceback
    result = {
        'business_slug': business_slug,
        'employee_db_id': employee_id,
        'steps': []
    }
    
    try:
        # Step 1: Look up business
        business = get_business_by_slug(business_slug, force_reload=True)
        if business:
            result['steps'].append(f"✓ Business found: {business.name} (id={business.id})")
            result['business_name'] = business.name
            result['business_id'] = business.id
            result['employee_count'] = len(business.employees)
            result['employee_model_ids'] = [e.id for e in business.employees]
        else:
            result['steps'].append(f"✗ Business NOT found for slug: {business_slug}")
            return jsonify(result), 404
        
        # Step 2: Look up DB business
        from db_service import get_db_business
        db_business = get_db_business(business.id)
        if db_business:
            result['steps'].append(f"✓ DB Business found: db_id={db_business.id}")
            result['db_business_id'] = db_business.id
        else:
            result['steps'].append(f"✗ DB Business NOT found for business.id={business.id}")
        
        # Step 3: Look up DBEmployee
        db_employee = DBEmployee.query.get(employee_id)
        if db_employee:
            result['steps'].append(f"✓ DBEmployee found: name={db_employee.name}, employee_id={db_employee.employee_id}, business_db_id={db_employee.business_db_id}")
            result['db_employee_name'] = db_employee.name
            result['db_employee_model_id'] = db_employee.employee_id
            result['db_employee_business_db_id'] = db_employee.business_db_id
        else:
            result['steps'].append(f"✗ DBEmployee NOT found for id={employee_id}")
            # List all employees in DB for this business
            if db_business:
                all_db_emps = DBEmployee.query.filter_by(business_db_id=db_business.id).all()
                result['all_db_employees'] = [(e.id, e.name, e.employee_id) for e in all_db_emps]
            return jsonify(result), 404
        
        # Step 4: Check if employee matches business
        if db_business and db_employee.business_db_id != db_business.id:
            result['steps'].append(f"✗ MISMATCH: Employee belongs to business_db_id={db_employee.business_db_id}, not {db_business.id}")
        else:
            result['steps'].append(f"✓ Employee belongs to correct business")
        
        # Step 5: Find matching Employee model
        employee_model = None
        for emp in business.employees:
            if emp.id == db_employee.employee_id:
                employee_model = emp
                break
        
        if employee_model:
            result['steps'].append(f"✓ Employee model found: {employee_model.name}")
            result['employee_model_name'] = employee_model.name
        else:
            result['steps'].append(f"✗ Employee model NOT found for employee_id={db_employee.employee_id}")
            result['steps'].append(f"  Available model IDs: {[e.id for e in business.employees]}")
        
        result['success'] = True
        return jsonify(result)
        
    except Exception as e:
        result['error'] = str(e)
        result['traceback'] = traceback.format_exc()
        return jsonify(result), 500


# ==================== SHIFT SWAP API ====================

def lookup_db_employee_by_any_id(employee_id_str):
    """
    Look up a DBEmployee by either DB ID (integer as string like "7") 
    or model ID (string like "owner_7").
    Returns (DBEmployee, model_id) tuple or (None, None) if not found.
    """
    if not employee_id_str:
        return None, None
    
    # Try as DB ID first (if it's a number)
    try:
        db_id = int(employee_id_str)
        db_emp = DBEmployee.query.get(db_id)
        if db_emp:
            return db_emp, db_emp.employee_id
    except (ValueError, TypeError):
        pass
    
    # Try as model ID (e.g., "owner_7")
    db_emp = DBEmployee.query.filter_by(employee_id=employee_id_str).first()
    if db_emp:
        return db_emp, employee_id_str
    
    return None, None

def format_shift_time(start_hour, end_hour):
    """Format shift hours to readable string like '9am-5pm'."""
    def fmt(h):
        if h == 0:
            return '12am'
        elif h < 12:
            return f'{h}am'
        elif h == 12:
            return '12pm'
        else:
            return f'{h-12}pm'
    return f'{fmt(start_hour)}-{fmt(end_hour)}'


def get_eligible_employees_for_swap(business, requester_id, shift_day, shift_start, shift_end, shift_role, week_start):
    """
    Find employees who are eligible to take a shift.
    
    Returns list of dicts with:
    - employee_id
    - employee_name
    - eligibility_type: 'pickup' (can just take it) or 'swap_only' (must swap a shift)
    - current_shifts: list of their current shifts for the week
    """
    from scheduler.models import TimeSlot
    
    eligible = []
    
    # Get the current schedule from database
    schedule = get_published_schedule_from_db(business.id, week_start)
    if not schedule:
        # No schedule means anyone available could pick it up
        pass
    
    # Get slot assignments from schedule
    # Schedule model uses slot_assignments directly, not get_schedule_data()
    slot_assignments = schedule.slot_assignments if schedule else {}
    
    # Helper to get employee_id from assignment (handles tuple or dict format)
    def get_assign_employee_id(assignment):
        if isinstance(assignment, (list, tuple)):
            return assignment[0]
        elif isinstance(assignment, dict):
            return assignment.get('employee_id')
        return None
    
    # Count hours per employee in current schedule
    def get_employee_hours(emp_id):
        hours = 0
        if not slot_assignments:
            return hours
        for slot_key, assignments in slot_assignments.items():
            for assignment in assignments:
                if get_assign_employee_id(assignment) == emp_id:
                    hours += 1
        return hours
    
    # Get employee shifts as continuous blocks
    def get_employee_shifts(emp_id):
        shifts = []
        if not slot_assignments:
            return shifts
        
        # Group by day
        day_hours = {}
        for slot_key, assignments in slot_assignments.items():
            # Handle both tuple keys (day, hour) and string keys "day,hour"
            if isinstance(slot_key, tuple):
                day, hour = slot_key
            else:
                parts = str(slot_key).split(',')
                if len(parts) >= 2:
                    day = int(parts[0])
                    hour = int(parts[1])
                else:
                    continue
            for assignment in assignments:
                if get_assign_employee_id(assignment) == emp_id:
                    if day not in day_hours:
                        day_hours[day] = []
                    day_hours[day].append(hour)
        
        # Convert to continuous shifts
        for day, hours in day_hours.items():
            hours = sorted(hours)
            if not hours:
                continue
            start = hours[0]
            prev = hours[0]
            for h in hours[1:]:
                if h != prev + 1:
                    shifts.append({'day': day, 'start': start, 'end': prev + 1})
                    start = h
                prev = h
            shifts.append({'day': day, 'start': start, 'end': prev + 1})
        
        return shifts
    
    # Handle requester_id which could be a DB id (int) or model id (string)
    requester_model_id = None
    if isinstance(requester_id, int) or (isinstance(requester_id, str) and requester_id.isdigit()):
        # It's a DB id - look up the model id
        db_emp = DBEmployee.query.get(int(requester_id))
        if db_emp:
            requester_model_id = db_emp.employee_id
    else:
        requester_model_id = requester_id
    
    for emp in business.employees:
        # Skip the requester (check both model id and potential db id match)
        if emp.id == requester_model_id or str(emp.id) == str(requester_id):
            continue
        
        # Check 1: Employee has the required role (if specified)
        if shift_role and shift_role not in emp.roles:
            continue
        
        # Check 2: Employee is available during the shift hours
        is_available = True
        for hour in range(shift_start, shift_end):
            slot = TimeSlot(shift_day, hour)
            if slot not in emp.availability:
                is_available = False
                break
        
        if not is_available:
            continue
        
        # Check 3: Employee doesn't have time off for this shift
        has_time_off = False
        for hour in range(shift_start, shift_end):
            slot = TimeSlot(shift_day, hour)
            if hasattr(emp, 'time_off') and slot in emp.time_off:
                has_time_off = True
                break
        
        if has_time_off:
            continue
        
        # Get current hours and shifts
        current_hours = get_employee_hours(emp.id)
        current_shifts = get_employee_shifts(emp.id)
        shift_duration = shift_end - shift_start
        
        # Check 4: Would picking up this shift exceed max hours?
        new_hours = current_hours + shift_duration
        can_pickup = new_hours <= emp.max_hours or emp.overtime_allowed
        
        # Note: We no longer disqualify based on number of days
        # Instead, we determine if they can pickup or need to swap
        
        eligible.append({
            'employee_id': emp.id,
            'employee_name': emp.name,
            'employee_email': emp.email,
            'eligibility_type': 'pickup' if can_pickup else 'swap_only',
            'current_hours': current_hours,
            'current_shifts': current_shifts,
            'would_exceed_hours': not can_pickup
        })
    
    return eligible


@app.route('/api/employee/<business_slug>/<int:employee_id>/swap-requests', methods=['GET'])
def get_swap_requests(business_slug, employee_id):
    """Get swap requests - both incoming (to respond to) and outgoing (created by employee)."""
    import traceback
    print(f"\n[DEBUG] get_swap_requests called: business_slug={business_slug}, employee_id={employee_id}")
    debug_step = "start"
    
    try:
        debug_step = "get_business"
        business = get_business_by_slug(business_slug, force_reload=True)
        if not business:
            print(f"[DEBUG] Business not found: {business_slug}")
            return jsonify({'success': False, 'message': 'Business not found'}), 404
        print(f"[DEBUG] Business found: {business.name}, id={business.id}")
        
        debug_step = "get_db_business"
        # Get business DB ID
        from db_service import get_db_business
        db_business = get_db_business(business.id)
        if not db_business:
            print(f"[DEBUG] No DB business found, returning empty")
            return jsonify({
                'success': True,
                'outgoing': [],
                'incoming': []
            })
        print(f"[DEBUG] DB Business found: db_id={db_business.id}")
        
        debug_step = "get_db_employee"
        # Look up the string employee model ID from the DB integer ID
        db_employee = DBEmployee.query.get(employee_id)
        employee_model_id = db_employee.employee_id if db_employee else None
        print(f"[DEBUG] DBEmployee lookup: db_id={employee_id} -> employee_model_id={employee_model_id}")
        
        debug_step = "query_outgoing"
        # Get outgoing requests (created by this employee) - check both DB ID (as string) and model ID
        print(f"[DEBUG] Querying outgoing requests with requester_employee_id='{employee_id}' (as string)")
        outgoing = ShiftSwapRequest.query.filter_by(
            business_db_id=db_business.id,
            requester_employee_id=str(employee_id)  # DB ID stored as string
        ).order_by(ShiftSwapRequest.created_at.desc()).all()
        print(f"[DEBUG] Found {len(outgoing)} outgoing requests")
        
        debug_step = "query_incoming"
        # Get incoming requests (where this employee is a recipient)
        # Recipients may store model IDs like "maria_0" OR DB IDs as strings like "20"
        print(f"[DEBUG] Querying incoming recipients with employee_id='{employee_model_id}' or '{employee_id}'")
        from sqlalchemy import or_
        possible_ids = [eid for eid in [employee_model_id, str(employee_id)] if eid]
        incoming_recipients = SwapRequestRecipient.query.filter(
            SwapRequestRecipient.employee_id.in_(possible_ids)
        ).all() if possible_ids else []
        print(f"[DEBUG] Found {len(incoming_recipients)} incoming recipients")
        
        incoming = []
        for recipient in incoming_recipients:
            swap_req = recipient.swap_request
            print(f"[DEBUG]   Processing recipient: swap_req.business_db_id={swap_req.business_db_id}, status={swap_req.status}, requester_employee_id={swap_req.requester_employee_id}")
            # Only include if the request is for this business
            if swap_req.business_db_id == db_business.id and swap_req.status == 'pending':
                # Get requester info - handle both DB ID (new format) and model ID (old format)
                requester_db = None
                requester_id = swap_req.requester_employee_id
                print(f"[DEBUG]   Looking up requester: {requester_id}")
                
                # Try as DB ID first (if it's a number)
                try:
                    db_id = int(requester_id)
                    requester_db = DBEmployee.query.get(db_id)
                    print(f"[DEBUG]   Looked up by DB ID {db_id}: found={requester_db is not None}")
                except (ValueError, TypeError):
                    # Not a number, try as model ID (e.g., "owner_7")
                    print(f"[DEBUG]   Not a DB ID, trying as model ID")
                    requester_db = DBEmployee.query.filter_by(employee_id=requester_id).first()
                    print(f"[DEBUG]   Looked up by model ID: found={requester_db is not None}")
                
                requester_name = requester_db.name if requester_db else 'Unknown'
                print(f"[DEBUG]   Requester name: {requester_name}")
                
                incoming.append({
                    **swap_req.to_dict(),
                    'requester_name': requester_name,
                    'my_response': recipient.response,
                    'my_eligibility_type': recipient.eligibility_type
                })
        print(f"[DEBUG] Final incoming count: {len(incoming)}")
        
        debug_step = "process_outgoing"
        # Get employee info for outgoing requests
        outgoing_data = []
        for i, req in enumerate(outgoing):
            debug_step = f"process_outgoing_{i}_to_dict"
            req_dict = req.to_dict()
            # Add recipient names
            recipients_with_names = []
            debug_step = f"process_outgoing_{i}_recipients"
            for r in req.recipients:
                emp = None
                for e in business.employees:
                    if e.id == r.employee_id:
                        emp = e
                        break
                debug_step = f"process_outgoing_{i}_recipient_to_dict"
                recipients_with_names.append({
                    **r.to_dict(),
                    'employee_name': emp.name if emp else 'Unknown'
                })
            req_dict['recipients'] = recipients_with_names
            outgoing_data.append(req_dict)
        
        print(f"[DEBUG] Returning {len(outgoing_data)} outgoing, {len(incoming)} incoming")
        return jsonify({
            'success': True,
            'outgoing': outgoing_data,
            'incoming': incoming
        })
    except Exception as e:
        print(f"[ERROR] get_swap_requests crashed at step '{debug_step}': {e}")
        traceback.print_exc()
        return jsonify({
            'success': False, 
            'error': str(e), 
            'failed_at_step': debug_step,
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/employee/<business_slug>/<int:employee_id>/swap-request', methods=['POST'])
def create_swap_request(business_slug, employee_id):
    """Create a new shift swap request."""
    import traceback
    print(f"\n[DEBUG] create_swap_request called: business_slug={business_slug}, employee_id={employee_id}")
    
    try:
        business = get_business_by_slug(business_slug, force_reload=True)
        if not business:
            print(f"[DEBUG] Business not found: {business_slug}")
            return jsonify({'success': False, 'message': 'Business not found'}), 404
        print(f"[DEBUG] Business found: {business.name}, id={business.id}")
        
        # Get business DB ID
        from db_service import get_db_business
        db_business = get_db_business(business.id)
        if not db_business:
            print(f"[DEBUG] DB Business not found")
            return jsonify({'success': False, 'message': 'Business not properly configured'}), 400
        print(f"[DEBUG] DB Business found: db_id={db_business.id}")
        
        # Look up the string employee_id from the DB integer ID
        db_employee = DBEmployee.query.get(employee_id)
        if not db_employee:
            print(f"[DEBUG] DBEmployee not found for id={employee_id}")
            return jsonify({'success': False, 'message': 'Employee not found'}), 404
        requester_model_id = db_employee.employee_id  # String ID like "maria_0"
        print(f"[DEBUG] Requester: db_id={employee_id}, model_id={requester_model_id}, name={db_employee.name}")
        
        data = request.json
        print(f"[DEBUG] Request data: {data}")
    
        # Required fields
        shift_day = data.get('day')
        shift_start = data.get('start_hour')
        shift_end = data.get('end_hour')
        week_start_str = data.get('week_start')
        
        if shift_day is None or shift_start is None or shift_end is None or not week_start_str:
            return jsonify({'success': False, 'message': 'Missing required shift details'}), 400
        
        try:
            week_start = date.fromisoformat(week_start_str)
        except ValueError:
            return jsonify({'success': False, 'message': 'Invalid week_start date format'}), 400
        
        print(f"[DEBUG] Shift: day={shift_day}, start={shift_start}, end={shift_end}, week={week_start}")
        
        # Optional fields
        shift_role = data.get('role_id')
        note = data.get('note', '')
        open_for_swaps = data.get('open_for_swaps', False)
        specific_recipients = data.get('recipients', [])  # Optional: specific employee IDs to request
        
        # Create the swap request - use string model ID for consistency
        swap_request = ShiftSwapRequest(
            business_db_id=db_business.id,
            requester_employee_id=str(employee_id),  # Store DB ID as string for now
            original_day=shift_day,
            original_start_hour=shift_start,
            original_end_hour=shift_end,
            original_role_id=shift_role,
            week_start_date=week_start,
            note=note,
            open_for_swaps=bool(open_for_swaps),
            status='pending'
        )
        
        # Set expiration (48 hours from now)
        swap_request.expires_at = datetime.utcnow() + timedelta(hours=48)
        
        db.session.add(swap_request)
        db.session.flush()  # Get the ID
        print(f"[DEBUG] Created swap request with id={swap_request.id}")
        
        # Find eligible employees - use string model ID for comparison
        all_eligible = get_eligible_employees_for_swap(
            business, requester_model_id, shift_day, shift_start, shift_end, shift_role, week_start
        )
        print(f"[DEBUG] Found {len(all_eligible)} eligible employees")
        
        # Filter to specific recipients if provided
        if specific_recipients:
            eligible_to_notify = [e for e in all_eligible if e['employee_id'] in specific_recipients]
        else:
            eligible_to_notify = all_eligible
        
        if not eligible_to_notify:
            db.session.rollback()
            return jsonify({
                'success': False,
                'message': 'No eligible employees found to swap with',
                'eligible_count': len(all_eligible)
            }), 400
        
        # Create recipient records
        day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        shift_details = f"{day_names[shift_day]} {format_shift_time(shift_start, shift_end)}"
        
        # Get requester name using model ID
        requester_name = 'Unknown'
        for emp in business.employees:
            if emp.id == requester_model_id:
                requester_name = emp.name
                break
        print(f"[DEBUG] Requester name: {requester_name}")
        
        # Get custom business name
        business_name = _custom_businesses.get(business.id, {}).get('name', business.name)
        base_url = get_site_url()
        
        notifications_sent = 0
        notification_errors = []
        
        # Build recipient records (but don't send emails yet - do that in background)
        email_tasks = []
        for eligible in eligible_to_notify:
            recipient = SwapRequestRecipient(
                swap_request_id=swap_request.id,
                employee_id=eligible['employee_id'],
                eligibility_type=eligible['eligibility_type'],
                response='pending'
            )
            db.session.add(recipient)
            
            # Queue email for background sending
            if eligible.get('employee_email'):
                email_tasks.append({
                    'employee_id': eligible['employee_id'],
                    'employee_email': eligible['employee_email'],
                    'employee_name': eligible['employee_name'],
                    'eligibility_type': eligible['eligibility_type'],
                })
        
        db.session.commit()
        
        # Send emails in background thread
        if email_tasks:
            create_email_data = {
                'business_slug': business_slug,
                'requester_name': requester_name,
                'business_name': business_name,
                'base_url': base_url,
                'shift_details': shift_details,
                'tasks': email_tasks,
            }
            
            def send_create_emails_bg(data):
                try:
                    from app import app as flask_app
                    with flask_app.app_context():
                        email_service = get_email_service()
                        if not email_service.is_configured():
                            return
                        for task in data['tasks']:
                            try:
                                db_emp = DBEmployee.query.filter_by(employee_id=task['employee_id']).first()
                                if not db_emp:
                                    continue
                                portal_url = f"{data['base_url']}/employee/{data['business_slug']}/{db_emp.id}/schedule"
                                email_service.send_swap_request_notification(
                                    to_email=task['employee_email'],
                                    recipient_name=task['employee_name'],
                                    requester_name=data['requester_name'],
                                    business_name=data['business_name'],
                                    shift_details=data['shift_details'],
                                    eligibility_type=task['eligibility_type'],
                                    portal_url=portal_url
                                )
                                print(f"[SWAP] Create notification sent to {task['employee_email']}")
                            except Exception as e:
                                print(f"[SWAP] Warning: Could not send notification to {task['employee_name']}: {e}")
                except Exception as e:
                    print(f"[SWAP] Background create email thread error: {e}")
            
            threading.Thread(target=send_create_emails_bg, args=(create_email_data,), daemon=True).start()
        
        print(f"[DEBUG] Swap request created successfully, {len(email_tasks)} email(s) queued")
        return jsonify({
            'success': True,
            'swap_request': swap_request.to_dict(),
            'eligible_count': len(eligible_to_notify),
            'notifications_sent': len(email_tasks),
            'message': f'Swap request created and sent to {len(eligible_to_notify)} staff member(s).'
        })
    except Exception as e:
        print(f"[ERROR] create_swap_request crashed: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}), 500


@app.route('/api/employee/<business_slug>/<int:employee_id>/swap-request/<request_id>/respond', methods=['POST'])
def respond_to_swap_request(business_slug, employee_id, request_id):
    """Respond to a swap request (accept/decline)."""
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    
    data = request.json
    response_type = data.get('response')  # 'accept', 'decline', or 'counter_offer'
    swap_shift = data.get('swap_shift')  # Optional: shift to offer in return
    
    if response_type not in ['accept', 'decline', 'counter_offer']:
        return jsonify({'success': False, 'message': 'Invalid response type'}), 400
    
    # Find the swap request
    swap_request = ShiftSwapRequest.query.filter_by(request_id=request_id).first()
    if not swap_request:
        return jsonify({'success': False, 'message': 'Swap request not found'}), 404
    
    if swap_request.status != 'pending':
        return jsonify({'success': False, 'message': f'Swap request is already {swap_request.status}'}), 400
    
    # Look up the string employee model ID from the DB integer ID
    db_employee = DBEmployee.query.get(employee_id)
    employee_model_id = db_employee.employee_id if db_employee else None
    
    # Find this employee's recipient record - check both model ID and DB ID string
    recipient = SwapRequestRecipient.query.filter_by(
        swap_request_id=swap_request.id,
        employee_id=employee_model_id
    ).first()
    if not recipient:
        # Also try DB ID as string (counter offers may have stored it this way)
        recipient = SwapRequestRecipient.query.filter_by(
            swap_request_id=swap_request.id,
            employee_id=str(employee_id)
        ).first()
    
    if not recipient:
        return jsonify({'success': False, 'message': 'You are not a recipient of this swap request'}), 403
    
    # Handle counter offer - creates a new swap request back to the original requester
    if response_type == 'counter_offer':
        if not swap_shift:
            return jsonify({'success': False, 'message': 'Counter offer requires a shift to offer'}), 400
        
        from db_service import get_db_business
        db_business = get_db_business(business.id)
        
        # Mark original request as having a counter offer
        recipient.response = 'counter_offered'
        recipient.responded_at = datetime.utcnow()
        
        # Get counter-offerer info
        counter_offerer_name = db_employee.name if db_employee else 'A coworker'
        
        # Create a new counter offer request
        day_names = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
        counter_request = ShiftSwapRequest(
            business_db_id=db_business.id,
            requester_employee_id=str(employee_id),  # Store DB ID as string
            original_day=swap_shift.get('day'),
            original_start_hour=swap_shift.get('start_hour'),
            original_end_hour=swap_shift.get('end_hour'),
            original_role_id=swap_shift.get('role_id'),
            week_start_date=swap_request.week_start_date,
            note=f"Swap offer for your {day_names[swap_request.original_day]} {format_shift_time(swap_request.original_start_hour, swap_request.original_end_hour)} shift",
            status='pending',
            # Mark as counter offer and link to original request
            is_counter_offer=True,
            counter_offer_for_id=swap_request.id
        )
        db.session.add(counter_request)
        db.session.flush()
        
        # Add original requester as recipient - need to use model ID since that's how incoming queries work
        requester_db_emp, requester_model_id = lookup_db_employee_by_any_id(swap_request.requester_employee_id)
        counter_recipient = SwapRequestRecipient(
            swap_request_id=counter_request.id,
            employee_id=requester_model_id or swap_request.requester_employee_id,
            eligibility_type='swap_only'  # They must accept the swap
        )
        print(f"[SWAP] Counter offer recipient: requester_employee_id={swap_request.requester_employee_id} -> model_id={requester_model_id}")
        db.session.add(counter_recipient)
        db.session.commit()
        
        # TODO: Send notification email about counter offer
        
        return jsonify({
            'success': True,
            'message': 'Counter offer sent successfully',
            'counter_offer_id': counter_request.request_id
        })
    
    if response_type == 'decline':
        recipient.response = 'declined'
        recipient.responded_at = datetime.utcnow()
        
        # Check if ALL recipients have now declined - if so, mark the whole request as declined
        all_recipients = SwapRequestRecipient.query.filter_by(swap_request_id=swap_request.id).all()
        all_declined = all(r.response == 'declined' for r in all_recipients)
        if all_declined:
            swap_request.status = 'declined'
            swap_request.resolved_at = datetime.utcnow()
            print(f"[SWAP] All recipients declined - marking request {swap_request.request_id} as declined")
        
        db.session.commit()
        
        # Send decline notification in background
        day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        shift_details = f"{day_names[swap_request.original_day]} {format_shift_time(swap_request.original_start_hour, swap_request.original_end_hour)}"
        
        db_requester, requester_model_id = lookup_db_employee_by_any_id(swap_request.requester_employee_id)
        
        requester = None
        decliner = None
        for emp in business.employees:
            if emp.id == requester_model_id:
                requester = emp
            if emp.id == employee_model_id:
                decliner = emp
        
        if requester and requester.email:
            decline_email_data = {
                'requester_email': requester.email,
                'requester_name': requester.name,
                'requester_model_id': requester.id,
                'decliner_name': decliner.name if decliner else 'A coworker',
                'business_name': _custom_businesses.get(business.id, {}).get('name', business.name),
                'business_slug': business_slug,
                'base_url': get_site_url(),
                'shift_details': shift_details,
            }
            
            def send_decline_email_bg(data):
                try:
                    from app import app as flask_app
                    with flask_app.app_context():
                        email_service = get_email_service()
                        if email_service.is_configured():
                            db_req = DBEmployee.query.filter_by(employee_id=data['requester_model_id']).first()
                            if db_req:
                                portal_url = f"{data['base_url']}/employee/{data['business_slug']}/{db_req.id}/schedule"
                                email_service.send_swap_response_notification(
                                    to_email=data['requester_email'],
                                    requester_name=data['requester_name'],
                                    responder_name=data['decliner_name'],
                                    business_name=data['business_name'],
                                    shift_details=data['shift_details'],
                                    response='declined',
                                    swap_shift_details=None,
                                    portal_url=portal_url
                                )
                except Exception as e:
                    print(f"[SWAP] Warning: Could not send decline notification: {e}")
            
            threading.Thread(target=send_decline_email_bg, args=(decline_email_data,), daemon=True).start()
        
        return jsonify({
            'success': True,
            'message': 'Swap request declined'
        })
    
    # Accept the swap
    # If employee must swap and didn't provide a shift, error
    # For counter offers, the swap is implicit - the original shift is what's being traded
    # So we don't require swap_shift for counter offer acceptance
    if recipient.eligibility_type == 'swap_only' and not swap_shift and not swap_request.is_counter_offer:
        return jsonify({
            'success': False,
            'message': 'You must offer a shift to swap since picking up would exceed your max hours'
        }), 400
    
    # For counter offers, auto-populate swap_shift from the original request
    # When A accepts B's counter offer, A gives up their original shift
    if swap_request.is_counter_offer and not swap_shift and swap_request.counter_offer_for_id:
        original_request = ShiftSwapRequest.query.get(swap_request.counter_offer_for_id)
        if original_request:
            swap_shift = {
                'day': original_request.original_day,
                'start_hour': original_request.original_start_hour,
                'end_hour': original_request.original_end_hour,
                'role_id': original_request.original_role_id
            }
            print(f"[SWAP] Counter offer: auto-populated swap_shift from original request {original_request.request_id}")
            # Also mark the original request as resolved
            original_request.status = 'accepted'
            original_request.resolved_at = datetime.utcnow()
            original_request.accepted_by_employee_id = swap_request.requester_employee_id
    
    # Update the swap request - store DB ID as string
    swap_request.status = 'accepted'
    swap_request.accepted_by_employee_id = str(employee_id)
    swap_request.resolved_at = datetime.utcnow()
    
    # Look up model IDs for schedule updates
    # requester_employee_id could be DB ID (string) or model ID - handle both
    db_requester, requester_model_id = lookup_db_employee_by_any_id(swap_request.requester_employee_id)
    accepter_model_id = employee_model_id  # Already looked up above
    
    # Record swap shift if provided
    if swap_shift:
        swap_request.swap_day = swap_shift.get('day')
        swap_request.swap_start_hour = swap_shift.get('start_hour')
        swap_request.swap_end_hour = swap_shift.get('end_hour')
        swap_request.swap_role_id = swap_shift.get('role_id')
    
    recipient.response = 'accepted'
    recipient.responded_at = datetime.utcnow()
    
    # Update the schedule in database
    # This modifies slot_assignments to swap the employees
    schedule_updated = False
    schedule_error = None
    
    from db_service import get_db_business
    db_business = get_db_business(business.id)
    if db_business:
        week_id = swap_request.week_start_date.strftime('%Y-W%V')
        print(f"[SWAP] Looking for schedule: business_db_id={db_business.id}, week_id={week_id}, week_start_date={swap_request.week_start_date}")
        
        # Try by week_id first, then fall back to week_start_date column
        # (handles timezone mismatch where client/server compute different week_ids for the same week)
        db_schedule = DBSchedule.query.filter_by(
            business_db_id=db_business.id,
            week_id=week_id,
            status='published'
        ).first()
        
        if not db_schedule:
            # Try by week_start_date directly
            db_schedule = DBSchedule.query.filter_by(
                business_db_id=db_business.id,
                week_start_date=swap_request.week_start_date,
                status='published'
            ).first()
            if db_schedule:
                print(f"[SWAP] Found schedule by week_start_date (week_id mismatch: stored={db_schedule.week_id}, computed={week_id})")
        
        if not db_schedule:
            # Last resort: find any published schedule that contains this day
            # The swap's week_start might differ from the schedule's week_start by up to 1 day (timezone issue)
            for delta in [-1, 1]:
                alt_date = swap_request.week_start_date + timedelta(days=delta)
                alt_week_id = alt_date.strftime('%Y-W%V')
                db_schedule = DBSchedule.query.filter_by(
                    business_db_id=db_business.id,
                    week_id=alt_week_id,
                    status='published'
                ).first()
                if db_schedule:
                    print(f"[SWAP] Found schedule with nearby date: alt_date={alt_date}, alt_week_id={alt_week_id}")
                    break
        
        if not db_schedule:
            print(f"[SWAP] ERROR: No published schedule found for week_id={week_id} or nearby dates")
            schedule_error = f"No published schedule found for week {week_id}"
        else:
            try:
                import json
                schedule_data = json.loads(db_schedule.schedule_json) if db_schedule.schedule_json else {}
                slot_assignments = schedule_data.get('slot_assignments', {})
                
                role_id = swap_request.original_role_id or 'staff'
                print(f"[SWAP] Updating schedule: removing {requester_model_id}, adding {accepter_model_id}")
                print(f"[SWAP] Original shift: day={swap_request.original_day}, hours={swap_request.original_start_hour}-{swap_request.original_end_hour}")
                
                # Remove requester from original shift, add accepter
                for hour in range(swap_request.original_start_hour, swap_request.original_end_hour):
                    slot_key = f"{swap_request.original_day},{hour}"
                    
                    if slot_key in slot_assignments:
                        current_assignments = slot_assignments[slot_key]
                        # Remove requester AND any existing accepter assignments (prevent duplicates)
                        new_assignments = []
                        for a in current_assignments:
                            if isinstance(a, (list, tuple)):
                                if a[0] != requester_model_id and a[0] != accepter_model_id:
                                    new_assignments.append(a)
                            elif isinstance(a, dict):
                                if a.get('employee_id') != requester_model_id and a.get('employee_id') != accepter_model_id:
                                    new_assignments.append(a)
                        
                        # Add accepter in the same format, with swap marker
                        if current_assignments and isinstance(current_assignments[0], (list, tuple)):
                            new_assignments.append([accepter_model_id, role_id])
                        else:
                            accepter_info = {
                                'employee_id': accepter_model_id, 
                                'role_id': role_id,
                                'via_swap': True,
                                'swapped_from': requester_model_id
                            }
                            for emp in business.employees:
                                if emp.id == accepter_model_id:
                                    accepter_info['employee_name'] = emp.name
                                    accepter_info['color'] = emp.color
                                    break
                            new_assignments.append(accepter_info)
                        
                        slot_assignments[slot_key] = new_assignments
                        print(f"[SWAP]   Updated slot {slot_key}: {len(new_assignments)} assignments")
                    else:
                        # Key doesn't exist, create new assignment
                        slot_assignments[slot_key] = [{'employee_id': accepter_model_id, 'role_id': role_id, 'via_swap': True, 'swapped_from': requester_model_id}]
                        print(f"[SWAP]   Created new slot {slot_key}")
                
                # If there's a swap shift, swap those too
                if swap_shift:
                    swap_role_id = swap_shift.get('role_id') or 'staff'
                    print(f"[SWAP] Also swapping reverse shift: day={swap_shift['day']}, hours={swap_shift['start_hour']}-{swap_shift['end_hour']}")
                    for hour in range(swap_shift['start_hour'], swap_shift['end_hour']):
                        slot_key = f"{swap_shift['day']},{hour}"
                        
                        if slot_key in slot_assignments:
                            current_assignments = slot_assignments[slot_key]
                            # Remove accepter AND any existing requester (prevent duplicates)
                            new_assignments = []
                            for a in current_assignments:
                                if isinstance(a, (list, tuple)):
                                    if a[0] != accepter_model_id and a[0] != requester_model_id:
                                        new_assignments.append(a)
                                elif isinstance(a, dict):
                                    if a.get('employee_id') != accepter_model_id and a.get('employee_id') != requester_model_id:
                                        new_assignments.append(a)
                            
                            # Add requester
                            if current_assignments and isinstance(current_assignments[0], (list, tuple)):
                                new_assignments.append([requester_model_id, swap_role_id])
                            else:
                                requester_info = {'employee_id': requester_model_id, 'role_id': swap_role_id}
                                for emp in business.employees:
                                    if emp.id == requester_model_id:
                                        requester_info['employee_name'] = emp.name
                                        requester_info['color'] = emp.color
                                        break
                                new_assignments.append(requester_info)
                            
                            slot_assignments[slot_key] = new_assignments
                
                # Save updated schedule
                schedule_data['slot_assignments'] = slot_assignments
                db_schedule.schedule_json = json.dumps(schedule_data)
                db.session.add(db_schedule)
                schedule_updated = True
                print(f"[SWAP] Schedule updated successfully")
            except Exception as e:
                import traceback
                print(f"[SWAP] ERROR updating schedule: {e}")
                traceback.print_exc()
                schedule_error = str(e)
    else:
        schedule_error = "Business not found in database"
    
    if not schedule_updated:
        # Roll back the status changes - don't mark as accepted if schedule wasn't updated
        db.session.rollback()
        print(f"[SWAP] Rolled back - schedule not updated. Error: {schedule_error}")
        return jsonify({
            'success': False,
            'message': f'Failed to update schedule: {schedule_error}'
        }), 500
    
    db.session.commit()
    
    # Send notifications in background thread (don't block the response)
    day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    shift_details = f"{day_names[swap_request.original_day]} {format_shift_time(swap_request.original_start_hour, swap_request.original_end_hour)}"
    swap_shift_details = None
    if swap_shift:
        swap_shift_details = f"{day_names[swap_shift['day']]} {format_shift_time(swap_shift['start_hour'], swap_shift['end_hour'])}"
    
    # Get names and emails using model IDs
    requester = None
    accepter = None
    for emp in business.employees:
        if emp.id == requester_model_id:
            requester = emp
        if emp.id == accepter_model_id:
            accepter = emp
    
    # Gather email data before spawning thread (avoid accessing Flask context in thread)
    email_data = {
        'business_slug': business_slug,
        'business_name': _custom_businesses.get(business.id, {}).get('name', business.name),
        'business_id': business.id,
        'base_url': get_site_url(),
        'shift_details': shift_details,
        'swap_shift_details': swap_shift_details,
        'requester_name': requester.name if requester else 'Unknown',
        'requester_email': requester.email if requester else None,
        'requester_model_id': requester.id if requester else None,
        'accepter_name': accepter.name if accepter else 'Unknown',
    }
    
    def send_swap_emails_background(email_data):
        """Send swap notification emails in background."""
        try:
            from app import app as flask_app
            with flask_app.app_context():
                email_service = get_email_service()
                if not email_service.is_configured():
                    return
                
                base_url = email_data['base_url']
                
                # Send to requester
                if email_data['requester_email'] and email_data['requester_model_id']:
                    try:
                        db_req = DBEmployee.query.filter_by(employee_id=email_data['requester_model_id']).first()
                        if db_req:
                            portal_url = f"{base_url}/employee/{email_data['business_slug']}/{db_req.id}/schedule"
                            email_service.send_swap_response_notification(
                                to_email=email_data['requester_email'],
                                requester_name=email_data['requester_name'],
                                responder_name=email_data['accepter_name'],
                                business_name=email_data['business_name'],
                                shift_details=email_data['shift_details'],
                                response='accepted',
                                swap_shift_details=email_data['swap_shift_details'],
                                portal_url=portal_url
                            )
                            print(f"[SWAP] Accept notification email sent to {email_data['requester_email']}")
                    except Exception as e:
                        print(f"[SWAP] Warning: Could not send acceptance notification: {e}")
                
                # Send to manager
                try:
                    from db_service import get_db_business
                    db_biz = get_db_business(email_data['business_id'])
                    if db_biz and db_biz.owner and db_biz.owner.email:
                        schedule_url = f"{base_url}/{email_data['business_slug']}/schedule"
                        manager_name = f"{db_biz.owner.first_name or ''} {db_biz.owner.last_name or ''}".strip()
                        if not manager_name:
                            manager_name = db_biz.owner.username
                        
                        email_service.send_swap_completed_manager_notification(
                            to_email=db_biz.owner.email,
                            manager_name=manager_name,
                            requester_name=email_data['requester_name'],
                            accepter_name=email_data['accepter_name'],
                            business_name=email_data['business_name'],
                            shift_details=email_data['shift_details'],
                            swap_shift_details=email_data['swap_shift_details'],
                            schedule_url=schedule_url
                        )
                        print(f"[SWAP] Manager notification email sent to {db_biz.owner.email}")
                except Exception as e:
                    print(f"[SWAP] Warning: Could not send manager notification: {e}")
        except Exception as e:
            print(f"[SWAP] Background email thread error: {e}")
    
    # Fire off emails in background - don't block the response
    threading.Thread(target=send_swap_emails_background, args=(email_data,), daemon=True).start()
    
    return jsonify({
        'success': True,
        'message': 'Swap request accepted! The schedule has been updated.',
        'swap_request': swap_request.to_dict()
    })


@app.route('/api/employee/<business_slug>/<int:employee_id>/swap-request/<request_id>/cancel', methods=['POST'])
def cancel_swap_request(business_slug, employee_id, request_id):
    """Cancel a swap request (only by the requester)."""
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    
    # Find the swap request
    swap_request = ShiftSwapRequest.query.filter_by(request_id=request_id).first()
    if not swap_request:
        return jsonify({'success': False, 'message': 'Swap request not found'}), 404
    
    # Only requester can cancel
    if swap_request.requester_employee_id != employee_id:
        return jsonify({'success': False, 'message': 'Only the requester can cancel'}), 403
    
    if swap_request.status != 'pending':
        return jsonify({'success': False, 'message': f'Cannot cancel - request is already {swap_request.status}'}), 400
    
    swap_request.status = 'cancelled'
    swap_request.resolved_at = datetime.utcnow()
    db.session.commit()
    
    return jsonify({
        'success': True,
        'message': 'Swap request cancelled'
    })


@app.route('/api/employee/<business_slug>/<int:employee_id>/eligible-for-swap', methods=['GET'])
def get_eligible_for_swap(business_slug, employee_id):
    """Get list of eligible employees for a potential swap (preview before creating request)."""
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    
    # Get query params
    shift_day = request.args.get('day', type=int)
    shift_start = request.args.get('start_hour', type=int)
    shift_end = request.args.get('end_hour', type=int)
    shift_role = request.args.get('role_id')
    week_start_str = request.args.get('week_start')
    
    if shift_day is None or shift_start is None or shift_end is None or not week_start_str:
        return jsonify({'success': False, 'message': 'Missing required parameters'}), 400
    
    try:
        week_start = date.fromisoformat(week_start_str)
    except ValueError:
        return jsonify({'success': False, 'message': 'Invalid week_start date format'}), 400
    
    eligible = get_eligible_employees_for_swap(
        business, employee_id, shift_day, shift_start, shift_end, shift_role, week_start
    )
    
    return jsonify({
        'success': True,
        'eligible': eligible,
        'total_count': len(eligible),
        'pickup_count': len([e for e in eligible if e['eligibility_type'] == 'pickup']),
        'swap_only_count': len([e for e in eligible if e['eligibility_type'] == 'swap_only'])
    })


# ==================== BUSINESS API ====================

@app.route('/api/businesses', methods=['GET'])
@login_required
def list_businesses():
    """List all available business scenarios."""
    # Ensure user's business exists if they have one (in case server restarted)
    ensure_user_business_exists(current_user)
    
    businesses = get_all_businesses()
    
    # Default emoji/color mapping for built-in businesses
    business_meta = {
        'coffee_shop': {'emoji': '☕', 'color': '#3b82f6'},
        'retail_store': {'emoji': '👗', 'color': '#f59e0b'},
        'restaurant': {'emoji': '🍽️', 'color': '#ef4444'},
        'call_center': {'emoji': '💻', 'color': '#4b5563'},
        'warehouse': {'emoji': '📦', 'color': '#8b5cf6'}
    }
    
    result = []
    for b in businesses:
        meta = business_meta.get(b.id, {'emoji': '🏢', 'color': '#6366f1'})
        # Check if custom metadata exists
        if b.id in _custom_businesses:
            meta = {
                'emoji': _custom_businesses[b.id].get('emoji', meta['emoji']),
                'color': _custom_businesses[b.id].get('color', meta['color'])
            }
            # Use custom name if set
            name = _custom_businesses[b.id].get('name', b.name)
        else:
            name = b.name
            
        result.append({
            "id": b.id,
            "name": name,
            "slug": get_business_slug(b.id),
            "description": b.description,
            "total_employees": len(b.employees),
            "total_roles": len(b.roles),
            "hours": f"{b.start_hour}:00-{b.end_hour}:00",
            "days_open": len(b.days_open),
            "emoji": meta['emoji'],
            "color": meta['color']
        })
    
    return jsonify({'businesses': result})


@app.route('/api/business/<business_id>', methods=['POST'])
@login_required
def switch_business(business_id):
    """Switch to a different business scenario."""
    global _current_business, _solver
    
    try:
        _current_business = get_business_by_id(business_id)
        _solver = None  # Reset solver
        
        # Get slug for URL navigation
        business_slug = get_business_slug(business_id)
        
        # Apply custom name if it exists
        if business_id in _custom_businesses:
            custom_name = _custom_businesses[business_id].get('name')
            if custom_name:
                # Update the business name temporarily
                business_dict = _current_business.to_dict()
                business_dict['name'] = custom_name
                business_dict['slug'] = business_slug
                return jsonify({
                    'success': True,
                    'business': business_dict,
                    'slug': business_slug,
                    'message': f'Switched to {custom_name}'
                })
        
        business_dict = _current_business.to_dict()
        business_dict['slug'] = business_slug
        return jsonify({
            'success': True,
            'business': business_dict,
            'slug': business_slug,
            'message': f'Switched to {_current_business.name}'
        })
    except ValueError as e:
        return jsonify({
            'success': False,
            'message': str(e)
        }), 400


@app.route('/api/business/save', methods=['POST'])
@login_required
def save_business():
    """Save or update business metadata (name, emoji, color)."""
    global _custom_businesses
    
    data = request.json
    business_id = data.get('id')
    name = data.get('name')
    emoji = data.get('emoji', '🏢')
    color = data.get('color', '#6366f1')
    
    if not name:
        return jsonify({'success': False, 'error': 'Name is required'}), 400
    
    # For existing businesses, just update metadata
    if business_id:
        try:
            # Verify business exists
            get_business_by_id(business_id)
            
            _custom_businesses[business_id] = {
                'name': name,
                'emoji': emoji,
                'color': color
            }
            save_custom_businesses()
            
            # Return new slug based on updated name
            new_slug = get_business_slug(business_id)
            
            return jsonify({
                'success': True,
                'business_id': business_id,
                'slug': new_slug,
                'message': 'Business updated'
            })
        except ValueError:
            return jsonify({'success': False, 'error': 'Business not found'}), 404
    else:
        # For now, we don't support creating entirely new businesses
        # Just return an error suggesting to use existing templates
        return jsonify({
            'success': False,
            'error': 'Creating new businesses from scratch is not yet supported. Please customize an existing business template instead.'
        }), 400


@app.route('/api/business/<business_id>', methods=['DELETE'])
@login_required
def delete_business(business_id):
    """Delete custom business metadata (reverts to default)."""
    global _custom_businesses
    
    if business_id in _custom_businesses:
        del _custom_businesses[business_id]
        save_custom_businesses()
        return jsonify({
            'success': True,
            'message': 'Business customizations removed'
        })
    
    return jsonify({
        'success': False,
        'error': 'No custom settings found for this business'
    }), 404


# ==================== SCHEDULE API ====================

def _apply_approved_time_off(business, week_start: date, week_end: date):
    """Apply approved time off requests to employees for schedule generation.
    
    This ensures employees with approved time off are not scheduled during those days.
    
    Args:
        business: The business scenario with employees
        week_start: Start date of the week being scheduled (Monday)
        week_end: End date of the week being scheduled (Sunday)
    """
    from db_service import get_db_business
    from models import PTORequest
    from scheduler.models import TimeSlot
    
    db_business = get_db_business(business.id)
    if not db_business:
        print(f"[TIME_OFF] No DB business found for {business.id}, skipping time off application", flush=True)
        return
    
    # Get all approved time off requests that overlap with this week
    approved_requests = PTORequest.query.filter(
        PTORequest.business_db_id == db_business.id,
        PTORequest.status == 'approved',
        PTORequest.start_date <= week_end,
        PTORequest.end_date >= week_start
    ).all()
    
    if not approved_requests:
        print(f"[TIME_OFF] No approved time off requests for week {week_start} to {week_end}", flush=True)
        return
    
    print(f"[TIME_OFF] Found {len(approved_requests)} approved time off requests", flush=True)
    
    # Build a mapping of employee_id to their time off days within this week
    employee_time_off = {}
    for req in approved_requests:
        emp_id = req.employee_id
        if emp_id not in employee_time_off:
            employee_time_off[emp_id] = set()
        
        # Calculate which days in the week are covered by this request
        current_date = max(req.start_date, week_start)
        request_end = min(req.end_date, week_end)
        
        while current_date <= request_end:
            # Convert date to day-of-week (0=Monday, 6=Sunday)
            day_of_week = current_date.weekday()
            employee_time_off[emp_id].add(day_of_week)
            current_date += timedelta(days=1)
    
    # Apply time off to each employee in the business
    for emp in business.employees:
        if emp.id in employee_time_off:
            time_off_days = employee_time_off[emp.id]
            print(f"[TIME_OFF] Blocking {emp.name} ({emp.id}) on days: {time_off_days}", flush=True)
            
            for day in time_off_days:
                # Block all hours for the day (the solver uses 0-23 range, but we block operating hours)
                emp.add_time_off(day)  # This blocks all hours for that day


def get_week_start(offset: int = 0) -> date:
    """Get the Monday of the week with the given offset from current week."""
    today = date.today()
    days_since_monday = today.weekday()
    monday = today - timedelta(days=days_since_monday)
    return monday + timedelta(weeks=offset)


@app.route('/api/generate', methods=['POST'])
@login_required
def generate_schedule():
    """Generate a new optimal schedule."""
    global _current_business, _solver
    
    # Get policies from request if provided
    data = request.json or {}
    policies = data.get('policies', None)
    week_offset = data.get('weekOffset', 0)
    business_id = data.get('businessId', None)
    
    # If businessId is provided, use that business (fixes multi-worker issue)
    if business_id:
        try:
            business = get_business_by_id(business_id)
            # Update global state to match
            if _current_business is None or _current_business.id != business_id:
                _current_business = business
                _solver = None
        except ValueError as e:
            print(f"[GENERATE] Business not found: {business_id}, error: {e}", flush=True)
            return jsonify({
                'success': False,
                'message': f'Business not found: {business_id}'
            }), 404
    else:
        business = get_current_business()
    
    print(f"[GENERATE] Starting schedule generation for business: {business.id} ({business.name})", flush=True)
    print(f"[GENERATE] Employees: {len(business.employees)}, Roles: {len(business.roles)}", flush=True)
    
    # Apply approved time off requests to employees before scheduling
    try:
        week_start = get_week_start(week_offset)
        week_end = week_start + timedelta(days=6)
        _apply_approved_time_off(business, week_start, week_end)
        print(f"[GENERATE] Applied approved time off for week {week_start} to {week_end}", flush=True)
    except Exception as e:
        print(f"[GENERATE] Warning: Could not apply time off requests: {e}", flush=True)
    
    try:
        # Apply policies if provided
        if policies:
            _current_policies['min_shift_length'] = policies.get('min_shift_length', _current_policies['min_shift_length'])
            _current_policies['max_hours_per_day'] = policies.get('max_hours_per_day', _current_policies['max_hours_per_day'])
            _current_policies['max_splits'] = policies.get('max_splits', _current_policies['max_splits'])
            _current_policies['max_split_shifts_per_week'] = policies.get('max_split_shifts_per_week', _current_policies['max_split_shifts_per_week'])
            _current_policies['scheduling_strategy'] = policies.get('scheduling_strategy', _current_policies['scheduling_strategy'])
            _current_policies['max_days_ft'] = policies.get('max_days_ft', _current_policies['max_days_ft'])
            _current_policies['max_days_ft_mode'] = policies.get('max_days_ft_mode', _current_policies['max_days_ft_mode'])
            _current_policies['max_days_pt'] = policies.get('max_days_pt', _current_policies['max_days_pt'])
            _current_policies['max_days_pt_mode'] = policies.get('max_days_pt_mode', _current_policies['max_days_pt_mode'])
        
        # Create solver for this specific business
        solver = AdvancedScheduleSolver(
            business=business,
            min_shift_hours=_current_policies['min_shift_length'],
            max_hours_per_day=_current_policies['max_hours_per_day'],
            max_splits_per_day=_current_policies['max_splits'],
            max_split_shifts_per_week=_current_policies['max_split_shifts_per_week'],
            scheduling_strategy=_current_policies['scheduling_strategy'],
            max_days_ft=_current_policies['max_days_ft'],
            max_days_ft_mode=_current_policies['max_days_ft_mode'],
            max_days_pt=_current_policies['max_days_pt'],
            max_days_pt_mode=_current_policies['max_days_pt_mode']
        )
        
        print(f"[GENERATE] Solver created, starting solve...", flush=True)
        
        # Solve
        schedule = solver.solve(time_limit_seconds=60.0)
        
        print(f"[GENERATE] Solve completed. Feasible: {schedule.is_feasible}", flush=True)
        
    except Exception as e:
        import traceback
        print(f"[GENERATE] ERROR during schedule generation: {e}", flush=True)
        traceback.print_exc()
        return jsonify({
            'success': False,
            'message': f'Error generating schedule: {str(e)}'
        }), 500
    
    # Save schedule to database if user is authenticated
    if schedule.is_feasible and current_user.is_authenticated:
        try:
            week_start = get_week_start(week_offset)
            save_schedule_to_db(business.id, schedule, week_start, status='draft')
            print(f"[GENERATE] Schedule saved to database", flush=True)
        except Exception as e:
            print(f"Warning: Could not save schedule to database: {e}", flush=True)
    
    return jsonify({
        'success': schedule.is_feasible,
        'schedule': schedule.to_dict(),
        'business': {
            'id': business.id,
            'name': business.name,
            'roles': [r.to_dict() for r in business.roles]
        },
        'employees': [emp.to_dict() for emp in business.employees],
        'message': 'Schedule generated successfully!' if schedule.is_feasible else 'No feasible schedule found.'
    })


@app.route('/api/alternative', methods=['POST'])
@login_required
def find_alternative():
    """Find an alternative schedule different from previous ones."""
    global _current_business, _solver
    
    # Get policies from request if provided
    data = request.json or {}
    policies = data.get('policies', None)
    business_id = data.get('businessId', None)
    week_offset = data.get('weekOffset', 0)
    
    # If businessId is provided, use that business (fixes multi-worker issue)
    if business_id:
        try:
            business = get_business_by_id(business_id)
            if _current_business is None or _current_business.id != business_id:
                _current_business = business
                _solver = None
        except ValueError:
            return jsonify({
                'success': False,
                'message': f'Business not found: {business_id}'
            }), 404
    else:
        business = get_current_business()
    
    # Apply approved time off requests to employees before scheduling
    try:
        week_start = get_week_start(week_offset)
        week_end = week_start + timedelta(days=6)
        _apply_approved_time_off(business, week_start, week_end)
        print(f"[ALTERNATIVE] Applied approved time off for week {week_start} to {week_end}", flush=True)
    except Exception as e:
        print(f"[ALTERNATIVE] Warning: Could not apply time off requests: {e}", flush=True)
    
    # Apply policies if provided
    if policies:
        _current_policies['min_shift_length'] = policies.get('min_shift_length', _current_policies['min_shift_length'])
        _current_policies['max_hours_per_day'] = policies.get('max_hours_per_day', _current_policies['max_hours_per_day'])
        _current_policies['max_splits'] = policies.get('max_splits', _current_policies['max_splits'])
        _current_policies['max_split_shifts_per_week'] = policies.get('max_split_shifts_per_week', _current_policies['max_split_shifts_per_week'])
        _current_policies['scheduling_strategy'] = policies.get('scheduling_strategy', _current_policies['scheduling_strategy'])
        _current_policies['max_days_ft'] = policies.get('max_days_ft', _current_policies['max_days_ft'])
        _current_policies['max_days_ft_mode'] = policies.get('max_days_ft_mode', _current_policies['max_days_ft_mode'])
        _current_policies['max_days_pt'] = policies.get('max_days_pt', _current_policies['max_days_pt'])
        _current_policies['max_days_pt_mode'] = policies.get('max_days_pt_mode', _current_policies['max_days_pt_mode'])
    
    # Always create a fresh solver to ensure time-off is respected
    solver = AdvancedScheduleSolver(
        business=business,
        min_shift_hours=_current_policies['min_shift_length'],
        max_hours_per_day=_current_policies['max_hours_per_day'],
        max_splits_per_day=_current_policies['max_splits'],
        max_split_shifts_per_week=_current_policies['max_split_shifts_per_week'],
        scheduling_strategy=_current_policies['scheduling_strategy'],
        max_days_ft=_current_policies['max_days_ft'],
        max_days_ft_mode=_current_policies['max_days_ft_mode'],
        max_days_pt=_current_policies['max_days_pt'],
        max_days_pt_mode=_current_policies['max_days_pt_mode']
    )
    
    # Find alternative
    schedule = solver.solve(find_alternative=True, time_limit_seconds=60.0)
    
    return jsonify({
        'success': schedule.is_feasible,
        'schedule': schedule.to_dict(),
        'business': {
            'id': business.id,
            'name': business.name,
            'roles': [r.to_dict() for r in business.roles]
        },
        'employees': [emp.to_dict() for emp in business.employees],
        'message': f'Alternative #{schedule.solution_index} found!' if schedule.is_feasible else 'No more alternative schedules available.'
    })


@app.route('/api/reset', methods=['POST'])
@login_required
def reset_solver():
    """Reset the solver to start fresh."""
    global _solver
    
    if _solver:
        _solver.reset()
    
    return jsonify({
        'success': True,
        'message': 'Solver reset. Ready to generate new schedules.'
    })


@app.route('/api/schedule/publish', methods=['POST'])
@login_required
def publish_schedule():
    """Publish the current schedule for a week."""
    global _current_business
    
    data = request.json or {}
    week_offset = data.get('weekOffset', 0)
    business_id = data.get('businessId', None)
    
    # If businessId is provided, use that business (fixes multi-worker issue)
    if business_id:
        try:
            business = get_business_by_id(business_id)
            _current_business = business
        except ValueError:
            return jsonify({
                'success': False,
                'message': f'Business not found: {business_id}'
            }), 404
    else:
        business = get_current_business()
    
    week_start = get_week_start(week_offset)
    
    try:
        success = publish_schedule_in_db(business.id, week_start)
        if success:
            return jsonify({
                'success': True,
                'message': 'Schedule published successfully!'
            })
        else:
            return jsonify({
                'success': False,
                'message': 'No schedule found to publish'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'Failed to publish schedule: {str(e)}'
        }), 500


@app.route('/api/schedule/load', methods=['GET'])
@login_required
def load_saved_schedule():
    """Load a saved schedule for a specific week."""
    global _current_business
    
    week_offset = request.args.get('weekOffset', 0, type=int)
    business_id = request.args.get('businessId', None)
    
    # If businessId is provided, use that business (fixes multi-worker issue)
    if business_id:
        try:
            business = get_business_by_id(business_id)
            _current_business = business
        except ValueError:
            return jsonify({
                'success': False,
                'message': f'Business not found: {business_id}'
            }), 404
    else:
        business = get_current_business()
    
    week_start = get_week_start(week_offset)
    
    try:
        schedule, status = get_schedule_with_status_from_db(business.id, week_start)
        if schedule:
            return jsonify({
                'success': True,
                'schedule': schedule.to_dict(),
                'status': status,  # 'draft' or 'published'
                'business': {
                    'id': business.id,
                    'name': business.name,
                    'roles': [r.to_dict() for r in business.roles]
                },
                'employees': [emp.to_dict() for emp in business.employees]
            })
        else:
            return jsonify({
                'success': False,
                'message': 'No saved schedule for this week'
            }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'Failed to load schedule: {str(e)}'
        }), 500


# ==================== EMPLOYEE API ====================

@app.route('/api/employees', methods=['GET'])
@login_required
def get_employees():
    """Get the list of employees for the current business."""
    business = get_current_business()
    
    return jsonify({
        'success': True,
        'employees': [emp.to_dict() for emp in business.employees],
        'roles': [r.to_dict() for r in business.roles],
        'days': DAYS_OF_WEEK,
        'hours': list(business.get_operating_hours())
    })


@app.route('/api/employees', methods=['POST'])
@login_required
def add_employee():
    """Add a new employee to the current business."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Check if email is already in use by another employee
    employee_email = (data.get('email') or '').strip().lower()
    if employee_email:
        existing_user = User.query.filter_by(email=employee_email).first()
        if existing_user and existing_user.linked_employee_id is not None:
            return jsonify({
                'success': False,
                'message': f'An employee account already exists with the email "{employee_email}". Please use a different email address.'
            }), 400
    
    # Generate unique ID
    emp_id = f"emp_{uuid.uuid4().hex[:8]}"
    
    # Create employee
    classification = EmployeeClassification.FULL_TIME if data.get('classification') == 'full_time' else EmployeeClassification.PART_TIME
    
    employee = Employee(
        id=emp_id,
        name=data.get('name', 'New Employee'),
        email=data.get('email'),
        phone=data.get('phone'),
        classification=classification,
        min_hours=data.get('min_hours', 15),
        max_hours=data.get('max_hours', 25),
        roles=data.get('roles', []),
        needs_supervision=data.get('needs_supervision', False),
        can_supervise=data.get('can_supervise', False),
        overtime_allowed=data.get('overtime_allowed', False),
        hourly_rate=data.get('hourly_rate', 15.0),
        color=data.get('color', '#4CAF50')
    )
    
    # Set default availability (all operating hours)
    for day in business.days_open:
        employee.add_availability(day, business.start_hour, business.end_hour)
    
    business.employees.append(employee)
    _solver = None  # Reset solver
    
    # Sync to database for persistence
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    # Handle invitation sending
    invitation_sent = False
    invitation_methods = []
    invitation_errors = []
    
    # Log invitation request details
    print(f"[INVITE] send_invite={data.get('send_invite')}, invite_by_email={data.get('invite_by_email')}, employee_email={employee.email}", flush=True)
    
    if data.get('send_invite'):
        try:
            business_slug = get_business_slug(business.id)
            base_url = get_site_url()
            # Get the database ID for the employee (the URL uses integer DB ID, not string model ID)
            db_emp = DBEmployee.query.filter_by(employee_id=employee.id).first()
            if not db_emp:
                raise ValueError("Employee not found in database for invitation URL")
            portal_url = f"{base_url}/employee/{business_slug}/{db_emp.id}/schedule"
            login_url = f"{base_url}/login"
            
            # Get custom business name if available
            business_name = _custom_businesses.get(business.id, {}).get('name', business.name)
            
            print(f"[INVITE] portal_url={portal_url}, business_name={business_name}", flush=True)
            
            if data.get('invite_by_email') and employee.email:
                # Create or get employee user account
                emp_user, temp_password = create_or_get_employee_user(db_emp, employee.email, employee.name)
                if emp_user is None:
                    invitation_errors.append("Email is already associated with another account")
                else:
                    email_service = get_email_service()
                    print(f"[INVITE] email_service.is_configured()={email_service.is_configured()}", flush=True)
                    if email_service.is_configured():
                        success, msg = email_service.send_portal_invitation(
                            to_email=employee.email,
                            employee_name=employee.name,
                            business_name=business_name,
                            portal_url=portal_url,
                            login_url=login_url,
                            temp_password=temp_password
                        )
                        print(f"[INVITE] send_portal_invitation result: success={success}, msg={msg}", flush=True)
                        if success:
                            invitation_methods.append('email')
                            invitation_sent = True
                        else:
                            invitation_errors.append(f"Email: {msg}")
                    else:
                        invitation_errors.append("Email service not configured")
                        print(f"[INVITE] Email service NOT configured - MAIL_USERNAME={email_service.username}, has_password={bool(email_service.password)}", flush=True)
            elif data.get('invite_by_email') and not employee.email:
                invitation_errors.append("No email address provided")
            
            if data.get('invite_by_sms') and employee.phone:
                # SMS not implemented yet
                invitation_errors.append("SMS not yet implemented")
        except Exception as e:
            # Don't fail the whole request if email fails
            invitation_errors.append(f"Failed to send invitation: {str(e)}")
            print(f"[INVITE] Exception: {str(e)}", flush=True)
            import traceback
            traceback.print_exc()
    
    response_data = {
        'success': True,
        'employee': employee.to_dict(),
        'message': 'Employee added successfully'
    }
    
    if invitation_sent:
        response_data['invitation_sent'] = True
        response_data['invitation_methods'] = invitation_methods
        response_data['message'] = f"Employee added and invitation sent via {', '.join(invitation_methods)}"
    elif invitation_errors:
        response_data['invitation_errors'] = invitation_errors
    
    return jsonify(response_data)


@app.route('/api/employees/<emp_id>', methods=['PUT'])
@login_required
def update_employee(emp_id):
    """Update an existing employee."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Find employee
    employee = None
    for emp in business.employees:
        if emp.id == emp_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': 'Employee not found'
        }), 404
    
    # Update fields
    if 'name' in data:
        employee.name = data['name']
    if 'email' in data:
        employee.email = data['email']
    if 'phone' in data:
        employee.phone = data['phone']
    if 'classification' in data:
        employee.classification = EmployeeClassification.FULL_TIME if data['classification'] == 'full_time' else EmployeeClassification.PART_TIME
    if 'min_hours' in data:
        employee.min_hours = data['min_hours']
    if 'max_hours' in data:
        employee.max_hours = data['max_hours']
    if 'roles' in data:
        employee.roles = data['roles']
    if 'needs_supervision' in data:
        employee.needs_supervision = data['needs_supervision']
    if 'can_supervise' in data:
        employee.can_supervise = data['can_supervise']
    if 'overtime_allowed' in data:
        employee.overtime_allowed = data['overtime_allowed']
    if 'hourly_rate' in data:
        employee.hourly_rate = data['hourly_rate']
    if 'color' in data:
        employee.color = data['color']
    
    _solver = None  # Reset solver
    
    # Sync to database for persistence
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    # Handle invitation sending (for updates too)
    invitation_sent = False
    invitation_methods = []
    invitation_errors = []
    
    # Log invitation request details
    print(f"[INVITE-UPDATE] send_invite={data.get('send_invite')}, invite_by_email={data.get('invite_by_email')}, employee_email={employee.email}", flush=True)
    
    if data.get('send_invite'):
        try:
            business_slug = get_business_slug(business.id)
            base_url = get_site_url()
            # Get the database ID for the employee (the URL uses integer DB ID, not string model ID)
            db_emp = DBEmployee.query.filter_by(employee_id=employee.id).first()
            if not db_emp:
                raise ValueError("Employee not found in database for invitation URL")
            portal_url = f"{base_url}/employee/{business_slug}/{db_emp.id}/schedule"
            login_url = f"{base_url}/login"
            
            # Get custom business name if available
            business_name = _custom_businesses.get(business.id, {}).get('name', business.name)
            
            print(f"[INVITE-UPDATE] portal_url={portal_url}, business_name={business_name}", flush=True)
            
            if data.get('invite_by_email') and employee.email:
                # Create or get employee user account
                emp_user, temp_password = create_or_get_employee_user(db_emp, employee.email, employee.name)
                if emp_user is None:
                    invitation_errors.append("Email is already associated with another account")
                else:
                    email_service = get_email_service()
                    print(f"[INVITE-UPDATE] email_service.is_configured()={email_service.is_configured()}", flush=True)
                    if email_service.is_configured():
                        success, msg = email_service.send_portal_invitation(
                            to_email=employee.email,
                            employee_name=employee.name,
                            business_name=business_name,
                            portal_url=portal_url,
                            login_url=login_url,
                            temp_password=temp_password
                        )
                        print(f"[INVITE-UPDATE] send_portal_invitation result: success={success}, msg={msg}", flush=True)
                        if success:
                            invitation_methods.append('email')
                            invitation_sent = True
                        else:
                            invitation_errors.append(f"Email: {msg}")
                    else:
                        invitation_errors.append("Email service not configured")
                        print(f"[INVITE-UPDATE] Email service NOT configured - MAIL_USERNAME={email_service.username}, has_password={bool(email_service.password)}", flush=True)
            elif data.get('invite_by_email') and not employee.email:
                invitation_errors.append("No email address provided")
            
            if data.get('invite_by_sms') and employee.phone:
                # SMS not implemented yet
                invitation_errors.append("SMS not yet implemented")
        except Exception as e:
            # Don't fail the whole request if email fails
            invitation_errors.append(f"Failed to send invitation: {str(e)}")
            print(f"[INVITE-UPDATE] Exception: {str(e)}", flush=True)
            import traceback
            traceback.print_exc()
    
    response_data = {
        'success': True,
        'employee': employee.to_dict(),
        'message': 'Employee updated successfully'
    }
    
    if invitation_sent:
        response_data['invitation_sent'] = True
        response_data['invitation_methods'] = invitation_methods
        response_data['message'] = f"Employee updated and invitation sent via {', '.join(invitation_methods)}"
    elif invitation_errors:
        response_data['invitation_errors'] = invitation_errors
    
    return jsonify(response_data)


@app.route('/api/employees/<emp_id>', methods=['DELETE'])
@login_required
def delete_employee(emp_id):
    """Delete an employee from the current business."""
    global _solver
    business = get_current_business()
    
    # Find and remove employee from in-memory list
    employee = None
    for i, emp in enumerate(business.employees):
        if emp.id == emp_id:
            employee = business.employees.pop(i)
            break
    
    if not employee:
        # Employee not in memory — may be a multi-worker sync issue.
        # Try to reload business from DB and retry.
        try:
            from scheduler.businesses import get_business_by_id as _get_biz
            reloaded = _get_biz(business.id, force_reload=True)
            if reloaded:
                business = reloaded
                for i, emp in enumerate(business.employees):
                    if emp.id == emp_id:
                        employee = business.employees.pop(i)
                        break
        except Exception as e:
            print(f"[DELETE] Reload attempt failed: {e}", flush=True)
    
    if not employee:
        # Still not found — try deleting directly from DB as last resort
        try:
            db_emp = DBEmployee.query.filter_by(employee_id=emp_id).first()
            if db_emp:
                emp_name = db_emp.name
                # Also clean up any linked user account
                linked_user = User.query.filter_by(linked_employee_id=db_emp.id).first()
                if linked_user:
                    linked_user.linked_employee_id = None
                db.session.delete(db_emp)
                db.session.commit()
                _solver = None
                return jsonify({
                    'success': True,
                    'message': f'{emp_name} removed successfully'
                })
        except Exception as e:
            print(f"[DELETE] Direct DB delete failed: {e}", flush=True)
        
        return jsonify({
            'success': False,
            'message': 'Employee not found. Please refresh the page and try again.'
        }), 404
    
    _solver = None  # Reset solver
    
    # Also clean up any linked user account in the DB
    try:
        db_emp = DBEmployee.query.filter_by(employee_id=emp_id).first()
        if db_emp:
            linked_user = User.query.filter_by(linked_employee_id=db_emp.id).first()
            if linked_user:
                linked_user.linked_employee_id = None
                db.session.commit()
    except Exception as e:
        print(f"[DELETE] User cleanup warning: {e}", flush=True)
    
    # Sync to database for persistence
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    return jsonify({
        'success': True,
        'message': f'{employee.name} removed successfully'
    })


@app.route('/api/employees/<emp_id>/invite', methods=['POST'])
@login_required
def send_employee_invitation(emp_id):
    """Send portal invitation to an employee."""
    business = get_current_business()
    data = request.json
    
    # Find employee
    employee = None
    for emp in business.employees:
        if emp.id == emp_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': 'Employee not found'
        }), 404
    
    invite_by_email = data.get('email', False)
    invite_by_sms = data.get('sms', False)
    
    if not invite_by_email and not invite_by_sms:
        return jsonify({
            'success': False,
            'message': 'Please select at least one invitation method'
        }), 400
    
    # Generate invitation link
    business_slug = get_business_slug(business.id)
    base_url = get_site_url()
    # Get the database ID for the employee (the URL uses integer DB ID, not string model ID)
    db_emp = DBEmployee.query.filter_by(employee_id=employee.id).first()
    if not db_emp:
        return jsonify({
            'success': False,
            'message': 'Employee not found in database'
        }), 404
    portal_url = f"{base_url}/employee/{business_slug}/{db_emp.id}/schedule"
    login_url = f"{base_url}/login"
    
    # Get custom business name if available
    business_name = _custom_businesses.get(business.id, {}).get('name', business.name)
    
    invitation_methods = []
    invitation_errors = []
    
    if invite_by_email:
        if not employee.email:
            return jsonify({
                'success': False,
                'message': 'Employee does not have an email address'
            }), 400
        
        # Create or get employee user account
        emp_user, temp_password = create_or_get_employee_user(db_emp, employee.email, employee.name)
        if emp_user is None:
            return jsonify({
                'success': False,
                'message': 'Email is already associated with another account'
            }), 400
        
        email_service = get_email_service()
        if not email_service.is_configured():
            return jsonify({
                'success': False,
                'message': 'Email service not configured. Set MAIL_USERNAME and MAIL_PASSWORD environment variables.'
            }), 500
        
        success, msg = email_service.send_portal_invitation(
            to_email=employee.email,
            employee_name=employee.name,
            business_name=business_name,
            portal_url=portal_url,
            login_url=login_url,
            temp_password=temp_password
        )
        
        if success:
            invitation_methods.append('email')
        else:
            invitation_errors.append(msg)
    
    if invite_by_sms:
        if not employee.phone:
            return jsonify({
                'success': False,
                'message': 'Employee does not have a phone number'
            }), 400
        # SMS not implemented yet
        invitation_errors.append("SMS not yet implemented")
    
    if not invitation_methods and invitation_errors:
        return jsonify({
            'success': False,
            'message': invitation_errors[0]
        }), 500
    
    return jsonify({
        'success': True,
        'message': f"Invitation sent to {employee.name} via {', '.join(invitation_methods)}",
        'invitation_methods': invitation_methods,
        'portal_url': portal_url
    })


@app.route('/api/email/status', methods=['GET'])
@login_required
def email_status():
    """Check if email service is configured."""
    email_service = get_email_service()
    return jsonify({
        'configured': email_service.is_configured(),
        'server': email_service.server if email_service.is_configured() else None
    })


def _update_employee_availability_for_business(emp_id, business):
    """Shared availability update logic for manager endpoints."""
    global _solver
    data = request.json
    
    print(f"[DEBUG update_availability] emp_id={emp_id}", flush=True)
    print(f"[DEBUG update_availability] Received data: {data}", flush=True)
    
    # Find employee
    employee = None
    for emp in business.employees:
        if emp.id == emp_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': 'Employee not found'
        }), 404
    
    # Clear existing availability (both ranges and slots)
    employee.clear_availability()
    employee.clear_preferences()
    employee.clear_time_off()
    
    availability_data = data.get('availability', [])
    print(f"[DEBUG update_availability] availability_data type: {type(availability_data)}", flush=True)
    print(f"[DEBUG update_availability] availability_data: {availability_data}", flush=True)
    
    # Check if availability is in range format (dict) or slot format (list)
    if isinstance(availability_data, dict):
        # Range format: {"0": [[9, 17.5], [18, 21]], "1": [[9.25, 17]], ...}
        # This preserves 15-minute precision
        for day_str, ranges in availability_data.items():
            day = int(day_str)
            for start, end in ranges:
                print(f"[DEBUG update_availability] Adding range: day={day}, start={start} ({type(start)}), end={end} ({type(end)})", flush=True)
                # Use add_availability which stores both ranges and slots
                employee.add_availability(day, float(start), float(end))
    else:
        # Slot format: [{"day": 0, "hour": 9}, ...]
        # Group by day and create ranges from consecutive hours
        from collections import defaultdict
        day_hours = defaultdict(list)
        for slot in availability_data:
            day_hours[slot['day']].append(slot['hour'])
        
        for day, hours in day_hours.items():
            hours = sorted(set(hours))
            if not hours:
                continue
            # Convert to ranges
            start = hours[0]
            end = hours[0] + 1
            for h in hours[1:]:
                if h == end:
                    end = h + 1
                else:
                    employee.add_availability(day, float(start), float(end))
                    start = h
                    end = h + 1
            employee.add_availability(day, float(start), float(end))
    
    # Handle preferences (slot format only for now)
    for slot in data.get('preferences', []):
        employee.add_preference(slot['day'], float(slot['hour']), float(slot['hour'] + 1))
    
    # Handle time-off (slot format only for now)
    for slot in data.get('time_off', []):
        employee.add_time_off(slot['day'], float(slot['hour']), float(slot['hour'] + 1))
    
    print(f"[DEBUG update_availability] After adding, availability_ranges: {[r.to_dict() for r in employee.availability_ranges]}", flush=True)
    
    _solver = None  # Reset solver
    
    # Sync to database for persistence
    if current_user.is_authenticated:
        print(f"[DEBUG update_availability] Syncing to database...", flush=True)
        sync_business_to_db(business.id, current_user.id, business_obj=business)
        print(f"[DEBUG update_availability] Synced!", flush=True)
    
    emp_dict = employee.to_dict()
    print(f"[DEBUG update_availability] Returning employee.to_dict()['availability_ranges']: {emp_dict.get('availability_ranges')}", flush=True)
    
    return jsonify({
        'success': True,
        'employee': emp_dict,
        'availability': availability_data if isinstance(availability_data, dict) else None,
        'message': 'Availability updated successfully'
    })


@app.route('/api/employees/<emp_id>/availability', methods=['PUT'])
@login_required
def update_availability(emp_id):
    """Update an employee's availability with 15-minute precision support."""
    business = get_current_business()
    return _update_employee_availability_for_business(emp_id, business)


@app.route('/api/<business_slug>/employees/<emp_id>/availability', methods=['PUT'])
@login_required
def update_availability_by_slug(business_slug, emp_id):
    """Compatibility route for availability updates using business slug."""
    global _current_business
    business = get_business_by_slug(business_slug, force_reload=True)
    if not business:
        return jsonify({
            'success': False,
            'message': 'Business not found'
        }), 404
    
    if _current_business is None or _current_business.id != business.id:
        _current_business = business
    
    return _update_employee_availability_for_business(emp_id, business)


@app.route('/api/employees/<emp_id>/availability-cell', methods=['PUT'])
@login_required
def update_availability_cell(emp_id):
    """Update a single availability cell for an employee."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Find employee
    employee = None
    for emp in business.employees:
        if emp.id == emp_id:
            employee = emp
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': 'Employee not found'
        }), 404
    
    day = data.get('day')
    hour = data.get('hour')
    state = data.get('state')  # 'available', 'preferred', 'time-off', 'none'
    
    slot = TimeSlot(day, hour)
    
    # Remove from all sets first
    employee.availability.discard(slot)
    employee.preferences.discard(slot)
    employee.time_off.discard(slot)
    
    # Add to appropriate set
    if state == 'available':
        employee.availability.add(slot)
    elif state == 'preferred':
        employee.availability.add(slot)
        employee.preferences.add(slot)
    elif state == 'time-off':
        employee.time_off.add(slot)
    
    _solver = None  # Reset solver
    
    # Sync to database for persistence
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    return jsonify({
        'success': True,
        'message': 'Cell updated'
    })


# ==================== SETTINGS API ====================

@app.route('/api/settings', methods=['GET'])
@login_required
def get_settings():
    """Get current business settings."""
    business = get_current_business()
    
    return jsonify({
        'success': True,
        'settings': {
            'hours': {
                'start_hour': business.start_hour,
                'end_hour': business.end_hour
            },
            'days_open': business.days_open,
            'roles': [r.to_dict() for r in business.roles],
            'coverage_requirements': [c.to_dict() for c in business.coverage_requirements]
        }
    })


@app.route('/api/settings', methods=['PUT'])
@login_required
def update_settings():
    """Update business settings."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Update hours
    if 'hours' in data:
        if 'start_hour' in data['hours']:
            business.start_hour = data['hours']['start_hour']
        if 'end_hour' in data['hours']:
            business.end_hour = data['hours']['end_hour']
    
    # Update days open
    if 'days_open' in data:
        business.days_open = data['days_open']
    
    _solver = None  # Reset solver
    
    return jsonify({
        'success': True,
        'message': 'Settings updated successfully'
    })


@app.route('/api/<business_slug>/settings/roles', methods=['GET'])
@login_required
def get_roles(business_slug):
    """Get all roles for current business."""
    business = get_business_by_slug(business_slug)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    
    return jsonify({
        'success': True,
        'roles': [r.to_dict() for r in business.roles]
    })


@app.route('/api/<business_slug>/settings/roles', methods=['POST'])
@login_required
def add_role(business_slug):
    """Add a new role to the current business."""
    global _solver
    business = get_business_by_slug(business_slug)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    data = request.json
    
    # Generate unique ID
    role_id = f"role_{uuid.uuid4().hex[:6]}"
    
    role = Role(
        id=role_id,
        name=data.get('name', 'New Role'),
        color=data.get('color', '#6366f1')
    )
    
    business.roles.append(role)
    _solver = None
    
    # Sync to database
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    return jsonify({
        'success': True,
        'role': role.to_dict(),
        'message': 'Role added successfully'
    })


@app.route('/api/<business_slug>/settings/roles/<role_id>', methods=['PUT'])
@login_required
def update_role(business_slug, role_id):
    """Update an existing role."""
    global _solver
    business = get_business_by_slug(business_slug)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    data = request.json
    
    # Find role
    role = None
    for r in business.roles:
        if r.id == role_id:
            role = r
            break
    
    if not role:
        return jsonify({
            'success': False,
            'message': 'Role not found'
        }), 404
    
    # Update fields
    if 'name' in data:
        role.name = data['name']
    if 'color' in data:
        role.color = data['color']
    
    _solver = None
    
    # Sync to database
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    return jsonify({
        'success': True,
        'role': role.to_dict(),
        'message': 'Role updated successfully'
    })


@app.route('/api/<business_slug>/settings/roles/<role_id>', methods=['DELETE'])
@login_required
def delete_role(business_slug, role_id):
    """Delete a role from the current business."""
    global _solver
    business = get_business_by_slug(business_slug)
    if not business:
        return jsonify({'success': False, 'message': 'Business not found'}), 404
    
    # Find and remove role
    role = None
    for i, r in enumerate(business.roles):
        if r.id == role_id:
            role = business.roles.pop(i)
            break
    
    if not role:
        return jsonify({
            'success': False,
            'message': 'Role not found'
        }), 404
    
    # Remove role from employees
    for emp in business.employees:
        if role_id in emp.roles:
            emp.roles.remove(role_id)
    
    _solver = None
    
    # Sync to database
    if current_user.is_authenticated:
        sync_business_to_db(business.id, current_user.id, business_obj=business)
    
    return jsonify({
        'success': True,
        'message': f'Role "{role.name}" removed successfully'
    })


# ==================== STATS API ====================

@app.route('/api/stats')
@login_required
def get_stats():
    """Get comprehensive scheduling statistics."""
    business = get_current_business()
    
    # Calculate stats
    total_slots = 0
    for req in business.coverage_requirements:
        total_slots += req.min_staff
    
    ft_count = sum(1 for e in business.employees if e.is_full_time)
    pt_count = len(business.employees) - ft_count
    
    supervision_needed = sum(1 for e in business.employees if e.needs_supervision)
    supervisors = sum(1 for e in business.employees if e.can_supervise)
    
    ot_allowed = sum(1 for e in business.employees if e.overtime_allowed)
    
    return jsonify({
        'business': {
            'id': business.id,
            'name': business.name,
            'description': business.description
        },
        'coverage': {
            'total_slots_required': total_slots,
            'hours_per_day': len(list(business.get_operating_hours())),
            'days_per_week': len(business.days_open)
        },
        'employees': {
            'total': len(business.employees),
            'full_time': ft_count,
            'part_time': pt_count,
            'needs_supervision': supervision_needed,
            'can_supervise': supervisors,
            'overtime_allowed': ot_allowed
        },
        'roles': {
            'total': len(business.roles),
            'list': [{'id': r.id, 'name': r.name, 'color': r.color} for r in business.roles]
        }
    })


@app.route('/api/coverage')
@login_required
def get_coverage_requirements():
    """Get coverage requirements for the current business."""
    business = get_current_business()
    
    # Group by day and hour
    coverage = {}
    for req in business.coverage_requirements:
        key = f"{req.day},{req.hour}"
        if key not in coverage:
            coverage[key] = []
        coverage[key].append({
            'role_id': req.role_id,
            'min_staff': req.min_staff,
            'max_staff': req.max_staff,
            'is_peak': getattr(req, 'is_peak', False)
        })
    
    return jsonify({
        'success': True,
        'coverage': coverage,
        'peak_periods': [p.to_dict() for p in business.peak_periods],
        'role_configs': [c.to_dict() for c in business.role_coverage_configs],
        'days': business.days_open,
        'hours': list(business.get_operating_hours())
    })


# ==================== COVERAGE CONFIG API ====================

@app.route('/api/settings/peak-periods', methods=['GET'])
@login_required
def get_peak_periods():
    """Get peak periods for the current business."""
    business = get_current_business()
    return jsonify({
        'success': True,
        'peak_periods': [p.to_dict() for p in business.peak_periods]
    })


@app.route('/api/settings/peak-periods', methods=['PUT'])
@login_required
def update_peak_periods():
    """Update peak periods for the current business."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Clear existing and recreate
    business.peak_periods = []
    
    for period_data in data.get('peak_periods', []):
        period = PeakPeriod(
            name=period_data.get('name', 'Peak'),
            start_hour=period_data.get('start_hour', 8),
            end_hour=period_data.get('end_hour', 10),
            days=period_data.get('days', list(range(7)))
        )
        business.peak_periods.append(period)
    
    # Regenerate coverage requirements if using configs
    if business.role_coverage_configs:
        business.rebuild_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'peak_periods': [p.to_dict() for p in business.peak_periods],
        'message': 'Peak periods updated successfully'
    })


@app.route('/api/settings/role-coverage', methods=['GET'])
@login_required
def get_role_coverage():
    """Get role coverage configurations."""
    business = get_current_business()
    return jsonify({
        'success': True,
        'role_configs': [c.to_dict() for c in business.role_coverage_configs],
        'roles': [r.to_dict() for r in business.roles]
    })


@app.route('/api/settings/role-coverage', methods=['PUT'])
@login_required
def update_role_coverage():
    """Update role coverage configurations."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Clear existing and recreate
    business.role_coverage_configs = []
    
    for config_data in data.get('role_configs', []):
        config = RoleCoverageConfig(
            role_id=config_data.get('role_id'),
            default_min_staff=config_data.get('default_min_staff', 1),
            default_max_staff=config_data.get('default_max_staff', 3),
            peak_boost=config_data.get('peak_boost', 0),
            required_hours=config_data.get('required_hours', []),
            required_days=config_data.get('required_days', [])
        )
        business.role_coverage_configs.append(config)
    
    # Regenerate coverage requirements from configs
    business.rebuild_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'role_configs': [c.to_dict() for c in business.role_coverage_configs],
        'coverage_count': len(business.coverage_requirements),
        'message': 'Role coverage updated successfully'
    })


@app.route('/api/settings/role-coverage/<role_id>', methods=['PUT'])
@login_required
def update_single_role_coverage(role_id):
    """Update coverage configuration for a single role."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Find existing config or create new
    config = None
    for c in business.role_coverage_configs:
        if c.role_id == role_id:
            config = c
            break
    
    if not config:
        # Create new config
        config = RoleCoverageConfig(role_id=role_id)
        business.role_coverage_configs.append(config)
    
    # Update config
    if 'default_min_staff' in data:
        config.default_min_staff = data['default_min_staff']
    if 'default_max_staff' in data:
        config.default_max_staff = data['default_max_staff']
    if 'peak_boost' in data:
        config.peak_boost = data['peak_boost']
    if 'required_hours' in data:
        config.required_hours = data['required_hours']
    if 'required_days' in data:
        config.required_days = data['required_days']
    
    # Regenerate coverage requirements
    business.rebuild_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'role_config': config.to_dict(),
        'message': f'Coverage for {role_id} updated successfully'
    })


# ==================== COVERAGE MODE & SHIFTS API ====================

@app.route('/api/settings/coverage-mode', methods=['GET'])
@login_required
def get_coverage_mode():
    """Get the current coverage mode and setup status."""
    business = get_current_business()
    return jsonify({
        'success': True,
        'coverage_mode': business.coverage_mode.value,
        'has_completed_setup': business.has_completed_setup,
        'shift_templates': [s.to_dict() for s in business.shift_templates],
        'role_configs': [c.to_dict() for c in business.role_coverage_configs]
    })


@app.route('/api/settings/coverage-mode', methods=['PUT'])
@login_required
def set_coverage_mode():
    """Switch coverage mode between 'shifts' and 'detailed'."""
    global _solver
    business = get_current_business()
    data = request.json
    
    mode = data.get('mode', 'shifts')
    
    if mode == 'shifts':
        business.coverage_mode = CoverageMode.SHIFTS
    elif mode == 'detailed':
        business.coverage_mode = CoverageMode.DETAILED
    else:
        return jsonify({
            'success': False,
            'message': f'Invalid coverage mode: {mode}'
        }), 400
    
    # Mark setup as complete
    if data.get('complete_setup', False):
        business.has_completed_setup = True
    
    # Regenerate coverage requirements based on new mode
    business.coverage_requirements = business.generate_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'coverage_mode': business.coverage_mode.value,
        'has_completed_setup': business.has_completed_setup,
        'coverage_count': len(business.coverage_requirements),
        'message': f'Switched to {mode} mode'
    })


@app.route('/api/settings/shifts', methods=['GET'])
@login_required
def get_shift_templates():
    """Get all shift templates for the current business."""
    business = get_current_business()
    return jsonify({
        'success': True,
        'shifts': [s.to_dict() for s in business.shift_templates],
        'roles': [r.to_dict() for r in business.roles]
    })


@app.route('/api/settings/shifts', methods=['POST'])
@login_required
def add_shift_template():
    """Add a new shift template."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Generate unique ID
    shift_id = f"shift_{uuid.uuid4().hex[:6]}"
    
    # Create role requirements
    role_reqs = []
    for req in data.get('roles', []):
        count = req.get('count', 1)
        max_count = req.get('max_count', count)
        role_reqs.append(ShiftRoleRequirement(
            role_id=req.get('role_id'),
            count=count,
            max_count=max_count
        ))
    
    shift = ShiftTemplate(
        id=shift_id,
        name=data.get('name', 'New Shift'),
        start_hour=data.get('start_hour', 9),
        end_hour=data.get('end_hour', 17),
        roles=role_reqs,
        days=data.get('days', list(range(7))),
        color=data.get('color', '#6366f1')
    )
    
    business.shift_templates.append(shift)
    
    # Regenerate coverage if in shifts mode
    if business.coverage_mode == CoverageMode.SHIFTS:
        business.coverage_requirements = business.generate_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'shift': shift.to_dict(),
        'message': 'Shift added successfully'
    })


@app.route('/api/settings/shifts/<shift_id>', methods=['PUT'])
@login_required
def update_shift_template(shift_id):
    """Update an existing shift template."""
    global _solver
    business = get_current_business()
    data = request.json
    
    # Find shift
    shift = None
    for s in business.shift_templates:
        if s.id == shift_id:
            shift = s
            break
    
    if not shift:
        return jsonify({
            'success': False,
            'message': 'Shift not found'
        }), 404
    
    # Update fields
    if 'name' in data:
        shift.name = data['name']
    if 'start_hour' in data:
        shift.start_hour = data['start_hour']
    if 'end_hour' in data:
        shift.end_hour = data['end_hour']
    if 'days' in data:
        shift.days = data['days']
    if 'color' in data:
        shift.color = data['color']
    if 'roles' in data:
        shift.roles = []
        for req in data['roles']:
            count = req.get('count', 1)
            max_count = req.get('max_count', count)
            shift.roles.append(ShiftRoleRequirement(
                role_id=req.get('role_id'),
                count=count,
                max_count=max_count
            ))
    
    # Regenerate coverage if in shifts mode
    if business.coverage_mode == CoverageMode.SHIFTS:
        business.coverage_requirements = business.generate_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'shift': shift.to_dict(),
        'message': 'Shift updated successfully'
    })


@app.route('/api/settings/shifts/<shift_id>', methods=['DELETE'])
@login_required
def delete_shift_template(shift_id):
    """Delete a shift template."""
    global _solver
    business = get_current_business()
    
    # Find and remove shift
    shift = None
    for i, s in enumerate(business.shift_templates):
        if s.id == shift_id:
            shift = business.shift_templates.pop(i)
            break
    
    if not shift:
        return jsonify({
            'success': False,
            'message': 'Shift not found'
        }), 404
    
    # Regenerate coverage if in shifts mode
    if business.coverage_mode == CoverageMode.SHIFTS:
        business.coverage_requirements = business.generate_coverage_requirements()
    
    _solver = None
    
    return jsonify({
        'success': True,
        'message': f'Shift "{shift.name}" removed successfully'
    })


# ==================== BUSINESS SETTINGS API ====================

# List of demo/sample business IDs that use per-user settings
DEMO_BUSINESS_IDS = ['coffee_shop', 'retail_store', 'restaurant', 'call_center', 'warehouse']


def is_user_owned_business(business_id):
    """Check if a business is user-created (vs demo)."""
    return business_id.startswith('user_') or business_id not in DEMO_BUSINESS_IDS


@app.route('/api/business/<business_id>/settings', methods=['GET'])
def get_business_settings(business_id):
    """
    Get settings for a business.
    - For user-created businesses: returns global settings (applies to all visitors)
    - For demo businesses: returns user-specific settings if logged in, otherwise defaults
    """
    if is_user_owned_business(business_id):
        # User-created business: get global settings
        settings_record = BusinessSettings.query.filter_by(business_id=business_id).first()
        if settings_record:
            return jsonify({
                'success': True,
                'settings': settings_record.get_settings(),
                'type': 'global'
            })
        return jsonify({
            'success': True,
            'settings': {},
            'type': 'global'
        })
    else:
        # Demo business: get user-specific settings
        if current_user.is_authenticated:
            settings_record = UserBusinessSettings.query.filter_by(
                user_id=current_user.id,
                business_id=business_id
            ).first()
            if settings_record:
                return jsonify({
                    'success': True,
                    'settings': settings_record.get_settings(),
                    'type': 'user'
                })
        # Not logged in or no settings: return empty (use defaults)
        return jsonify({
            'success': True,
            'settings': {},
            'type': 'default'
        })


@app.route('/api/business/<business_id>/settings', methods=['POST', 'PUT'])
@login_required
def save_business_settings(business_id):
    """
    Save settings for a business.
    - For user-created businesses: only owner can save (applies globally)
    - For demo businesses: any logged-in user can save (applies only to them)
    """
    data = request.json or {}
    settings = data.get('settings', {})
    
    if is_user_owned_business(business_id):
        # User-created business: only owner can save
        settings_record = BusinessSettings.query.filter_by(business_id=business_id).first()
        
        if settings_record:
            # Check ownership
            if settings_record.owner_id != current_user.id:
                return jsonify({
                    'success': False,
                    'error': 'You do not own this business'
                }), 403
            settings_record.set_settings(settings)
        else:
            # Create new settings record
            settings_record = BusinessSettings(
                business_id=business_id,
                owner_id=current_user.id
            )
            settings_record.set_settings(settings)
            db.session.add(settings_record)
        
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Business settings saved globally',
            'type': 'global'
        })
    else:
        # Demo business: save for current user only
        settings_record = UserBusinessSettings.query.filter_by(
            user_id=current_user.id,
            business_id=business_id
        ).first()
        
        if settings_record:
            settings_record.set_settings(settings)
        else:
            settings_record = UserBusinessSettings(
                user_id=current_user.id,
                business_id=business_id
            )
            settings_record.set_settings(settings)
            db.session.add(settings_record)
        
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': 'Settings saved for your account',
            'type': 'user'
        })


if __name__ == '__main__':
    # Production settings from environment variables
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    port = int(os.environ.get('PORT', 5000))
    
    print("\n" + "=" * 60)
    print("   STAFF SCHEDULER PRO")
    print("   Professional Staff Management System")
    print("=" * 60)
    print(f"\n Starting server at http://localhost:{port}\n")
    
    # List available businesses
    for b in get_all_businesses():
        print(f"  [{b.id}] {b.name} - {len(b.employees)} staff, {len(b.roles)} roles")
    
    print("\n")
    app.run(debug=debug_mode, host='0.0.0.0', port=port)
