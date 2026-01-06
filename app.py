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
from scheduler import (
    AdvancedScheduleSolver,
    get_all_businesses,
    get_business_by_id,
    DAYS_OF_WEEK
)
from scheduler.models import (
    Employee, Role, TimeSlot, EmployeeClassification,
    PeakPeriod, RoleCoverageConfig, CoverageRequirement,
    CoverageMode, ShiftTemplate, ShiftRoleRequirement
)
from config import get_config
from models import db, bcrypt, User, BusinessSettings, UserBusinessSettings, init_db
from auth import auth_bp


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


def get_business_by_slug(slug):
    """Find a business by its slug (checking custom names first)."""
    slug = slug.lower()
    
    # Check custom business names first
    for business_id, custom_data in _custom_businesses.items():
        custom_name = custom_data.get('name')
        if custom_name and slugify(custom_name) == slug:
            return get_business_by_id(business_id)
    
    # Check all businesses by their default names
    for business in get_all_businesses():
        if slugify(business.name) == slug:
            return business
    
    # Finally, try matching directly by ID
    try:
        return get_business_by_id(slug)
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
    
    # Build business list for demo
    businesses_data = []
    business_meta = {
        'coffee_shop': {'emoji': '☕', 'color': '#3b82f6'},
        'retail_store': {'emoji': '👗', 'color': '#f59e0b'},
        'restaurant': {'emoji': '🍽️', 'color': '#ef4444'},
        'call_center': {'emoji': '💻', 'color': '#4b5563'},
        'warehouse': {'emoji': '📦', 'color': '#8b5cf6'}
    }
    
    for b in all_businesses:
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
def app_page(location_slug, page_slug):
    """Render the main app with specified location and page."""
    global _current_business, _solver
    
    # Validate page slug
    if page_slug not in PAGE_SLUGS:
        # Try to redirect to schedule for this location
        return redirect(f'/{location_slug}/schedule')
    
    # Find business by slug
    business = get_business_by_slug(location_slug)
    if not business:
        # Business not found, redirect to default
        default_business = get_current_business()
        location_slug = get_business_slug(default_business.id)
        return redirect(f'/{location_slug}/{page_slug}')
    
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
    
    # Build business list with custom metadata
    businesses_data = []
    for b in businesses:
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
            
        businesses_data.append({
            "id": b.id,
            "name": name,
            "slug": get_business_slug(b.id),
            "description": b.description,
            "total_employees": len(b.employees),
            "total_roles": len(b.roles),
            "emoji": meta['emoji'],
            "color": meta['color']
        })
    
    # Get the internal tab ID for the page
    initial_tab = PAGE_SLUGS.get(page_slug, 'schedule')
    
    # Pass user if authenticated, None otherwise
    user = current_user if current_user.is_authenticated else None
    
    return render_template(
        'index.html',
        business=business.to_dict(),
        businesses=businesses_data,
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


# ==================== BUSINESS API ====================

@app.route('/api/businesses', methods=['GET'])
@login_required
def list_businesses():
    """List all available business scenarios."""
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

@app.route('/api/generate', methods=['POST'])
@login_required
def generate_schedule():
    """Generate a new optimal schedule."""
    # Get policies from request if provided
    data = request.json or {}
    policies = data.get('policies', None)
    
    solver = get_solver(policies)
    business = get_current_business()
    
    # Reset solver to get fresh solution
    solver.reset()
    
    # Solve
    schedule = solver.solve(time_limit_seconds=60.0)
    
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
    # Get policies from request if provided
    data = request.json or {}
    policies = data.get('policies', None)
    
    solver = get_solver(policies)
    business = get_current_business()
    
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
    
    # Generate unique ID
    emp_id = f"emp_{uuid.uuid4().hex[:8]}"
    
    # Create employee
    classification = EmployeeClassification.FULL_TIME if data.get('classification') == 'full_time' else EmployeeClassification.PART_TIME
    
    employee = Employee(
        id=emp_id,
        name=data.get('name', 'New Employee'),
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
    
    return jsonify({
        'success': True,
        'employee': employee.to_dict(),
        'message': 'Employee added successfully'
    })


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
    
    return jsonify({
        'success': True,
        'employee': employee.to_dict(),
        'message': 'Employee updated successfully'
    })


@app.route('/api/employees/<emp_id>', methods=['DELETE'])
@login_required
def delete_employee(emp_id):
    """Delete an employee from the current business."""
    global _solver
    business = get_current_business()
    
    # Find and remove employee
    employee = None
    for i, emp in enumerate(business.employees):
        if emp.id == emp_id:
            employee = business.employees.pop(i)
            break
    
    if not employee:
        return jsonify({
            'success': False,
            'message': 'Employee not found'
        }), 404
    
    _solver = None  # Reset solver
    
    return jsonify({
        'success': True,
        'message': f'{employee.name} removed successfully'
    })


@app.route('/api/employees/<emp_id>/availability', methods=['PUT'])
@login_required
def update_availability(emp_id):
    """Update an employee's availability."""
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
    
    # Clear existing
    employee.availability.clear()
    employee.preferences.clear()
    employee.time_off.clear()
    
    # Set new availability
    for slot in data.get('availability', []):
        employee.availability.add(TimeSlot(slot['day'], slot['hour']))
    
    for slot in data.get('preferences', []):
        employee.preferences.add(TimeSlot(slot['day'], slot['hour']))
    
    for slot in data.get('time_off', []):
        employee.time_off.add(TimeSlot(slot['day'], slot['hour']))
    
    _solver = None  # Reset solver
    
    return jsonify({
        'success': True,
        'employee': employee.to_dict(),
        'message': 'Availability updated successfully'
    })


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


@app.route('/api/settings/roles', methods=['GET'])
@login_required
def get_roles():
    """Get all roles for current business."""
    business = get_current_business()
    
    return jsonify({
        'success': True,
        'roles': [r.to_dict() for r in business.roles]
    })


@app.route('/api/settings/roles', methods=['POST'])
@login_required
def add_role():
    """Add a new role to the current business."""
    global _solver
    business = get_current_business()
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
    
    return jsonify({
        'success': True,
        'role': role.to_dict(),
        'message': 'Role added successfully'
    })


@app.route('/api/settings/roles/<role_id>', methods=['PUT'])
@login_required
def update_role(role_id):
    """Update an existing role."""
    global _solver
    business = get_current_business()
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
    
    return jsonify({
        'success': True,
        'role': role.to_dict(),
        'message': 'Role updated successfully'
    })


@app.route('/api/settings/roles/<role_id>', methods=['DELETE'])
@login_required
def delete_role(role_id):
    """Delete a role from the current business."""
    global _solver
    business = get_current_business()
    
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
