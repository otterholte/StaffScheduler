"""Database models for user authentication, business settings, and scheduling data."""

from datetime import datetime, date
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from flask_bcrypt import Bcrypt
import json
import uuid

db = SQLAlchemy()
bcrypt = Bcrypt()


def generate_uuid():
    """Generate a unique string ID."""
    return str(uuid.uuid4())[:8]


class User(db.Model, UserMixin):
    """User model for authentication (managers and employees)."""
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    
    # Profile info
    first_name = db.Column(db.String(50), nullable=True)
    last_name = db.Column(db.String(50), nullable=True)
    company_name = db.Column(db.String(100), nullable=True)  # Set for managers only
    
    # Employee linking (set for employee users, NULL for managers)
    linked_employee_id = db.Column(db.Integer, db.ForeignKey('db_employees.id', ondelete='SET NULL'), nullable=True)
    
    # Account status
    is_active = db.Column(db.Boolean, default=True)
    is_verified = db.Column(db.Boolean, default=False)
    must_change_password = db.Column(db.Boolean, default=False)  # True for temp passwords

    # Promo code entered at sign-up (e.g. the founding-members free offer)
    promo_code = db.Column(db.String(40), nullable=True)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)
    
    # Relationship to linked employee
    linked_employee = db.relationship('DBEmployee', backref='user_account', foreign_keys=[linked_employee_id])
    
    def __repr__(self):
        return f'<User {self.username}>'
    
    @property
    def is_employee(self):
        """Check if this user is an employee (has linked employee record)."""
        return self.linked_employee_id is not None
    
    @property
    def is_manager(self):
        """Check if this user is a manager (has company_name set)."""
        return self.company_name is not None and self.company_name.strip() != ''
    
    def set_password(self, password):
        """Hash and set the user's password."""
        self.password_hash = bcrypt.generate_password_hash(password).decode('utf-8')
    
    def check_password(self, password):
        """Check if the provided password matches the hash."""
        return bcrypt.check_password_hash(self.password_hash, password)
    
    def to_dict(self):
        """Convert user to dictionary (excluding sensitive data)."""
        return {
            'id': self.id,
            'email': self.email,
            'username': self.username,
            'first_name': self.first_name,
            'last_name': self.last_name,
            'company_name': self.company_name,
            'is_verified': self.is_verified,
            'is_employee': self.is_employee,
            'is_manager': self.is_manager,
            'linked_employee_id': self.linked_employee_id,
            'must_change_password': self.must_change_password,
            'promo_code': self.promo_code,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None
        }


class BusinessSettings(db.Model):
    """
    Global settings for user-created businesses.
    These settings apply to ALL visitors of the business.
    """
    __tablename__ = 'business_settings'
    
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.String(100), unique=True, nullable=False, index=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    
    # Store settings as JSON
    settings_json = db.Column(db.Text, nullable=True)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationship
    owner = db.relationship('User', backref=db.backref('owned_businesses', lazy=True))
    
    def __repr__(self):
        return f'<BusinessSettings {self.business_id}>'
    
    def get_settings(self):
        """Get settings as a dictionary."""
        if self.settings_json:
            return json.loads(self.settings_json)
        return {}
    
    def set_settings(self, settings_dict):
        """Set settings from a dictionary."""
        self.settings_json = json.dumps(settings_dict)
    
    def to_dict(self):
        return {
            'business_id': self.business_id,
            'owner_id': self.owner_id,
            'settings': self.get_settings(),
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }


class UserBusinessSettings(db.Model):
    """
    Per-user settings for demo/sample businesses.
    These settings only apply to the specific user.
    """
    __tablename__ = 'user_business_settings'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    business_id = db.Column(db.String(100), nullable=False, index=True)
    
    # Store settings as JSON
    settings_json = db.Column(db.Text, nullable=True)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Unique constraint: one settings record per user per business
    __table_args__ = (db.UniqueConstraint('user_id', 'business_id', name='unique_user_business'),)
    
    # Relationship
    user = db.relationship('User', backref=db.backref('business_settings', lazy=True))
    
    def __repr__(self):
        return f'<UserBusinessSettings user={self.user_id} business={self.business_id}>'
    
    def get_settings(self):
        """Get settings as a dictionary."""
        if self.settings_json:
            return json.loads(self.settings_json)
        return {}
    
    def set_settings(self, settings_dict):
        """Set settings from a dictionary."""
        self.settings_json = json.dumps(settings_dict)
    
    def to_dict(self):
        return {
            'user_id': self.user_id,
            'business_id': self.business_id,
            'settings': self.get_settings(),
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }


# =============================================================================
# BUSINESS DATA PERSISTENCE MODELS
# =============================================================================

class DBBusiness(db.Model):
    """
    Persisted business data - stores the full business configuration.
    This replaces in-memory _business_cache for user-created businesses.
    """
    __tablename__ = 'businesses'
    
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.String(100), unique=True, nullable=False, index=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    
    # Business info
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    emoji = db.Column(db.String(10), default='🏢')
    color = db.Column(db.String(20), default='#6366f1')
    
    # Operating hours
    start_hour = db.Column(db.Integer, default=9)
    end_hour = db.Column(db.Integer, default=17)
    days_open = db.Column(db.String(50), default='0,1,2,3,4')  # Comma-separated day indices
    
    # Coverage mode: 'shifts' or 'detailed'
    coverage_mode = db.Column(db.String(20), default='shifts')

    # Peak periods + per-role coverage configs (used by 'detailed' mode), stored as JSON:
    # {"peak_periods": [...], "role_coverage_configs": [...]}
    coverage_config_json = db.Column(db.Text, nullable=True)

    # Setup status
    has_completed_setup = db.Column(db.Boolean, default=False)

    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    owner = db.relationship('User', backref=db.backref('businesses', lazy=True))
    employees = db.relationship('DBEmployee', backref='business', lazy=True, cascade='all, delete-orphan')
    roles = db.relationship('DBRole', backref='business', lazy=True, cascade='all, delete-orphan')
    shift_templates = db.relationship('DBShiftTemplate', backref='business', lazy=True, cascade='all, delete-orphan')
    schedules = db.relationship('DBSchedule', backref='business', lazy=True, cascade='all, delete-orphan')
    
    def __repr__(self):
        return f'<DBBusiness {self.business_id}: {self.name}>'
    
    def get_days_open_list(self):
        """Get days_open as a list of integers."""
        if not self.days_open:
            return []
        return [int(d) for d in self.days_open.split(',') if d]

    def set_days_open_list(self, days):
        """Set days_open from a list of integers."""
        self.days_open = ','.join(str(d) for d in days)

    def get_coverage_config(self):
        """Return {'peak_periods': [...], 'role_coverage_configs': [...]} (never None)."""
        if not self.coverage_config_json:
            return {'peak_periods': [], 'role_coverage_configs': []}
        try:
            data = json.loads(self.coverage_config_json)
        except json.JSONDecodeError:
            return {'peak_periods': [], 'role_coverage_configs': []}
        data.setdefault('peak_periods', [])
        data.setdefault('role_coverage_configs', [])
        return data

    def set_coverage_config(self, peak_periods, role_coverage_configs):
        self.coverage_config_json = json.dumps({
            'peak_periods': peak_periods,
            'role_coverage_configs': role_coverage_configs,
        })

    def to_dict(self):
        return {
            'business_id': self.business_id,
            'name': self.name,
            'description': self.description,
            'emoji': self.emoji,
            'color': self.color,
            'start_hour': self.start_hour,
            'end_hour': self.end_hour,
            'days_open': self.get_days_open_list(),
            'coverage_mode': self.coverage_mode,
            'has_completed_setup': self.has_completed_setup,
            'total_employees': len(self.employees),
            'total_roles': len(self.roles)
        }


class DBRole(db.Model):
    """Persisted role data for a business."""
    __tablename__ = 'db_roles'
    
    id = db.Column(db.Integer, primary_key=True)
    role_id = db.Column(db.String(50), nullable=False)  # e.g., "barista", "shift_lead"
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    
    name = db.Column(db.String(100), nullable=False)
    color = db.Column(db.String(20), default='#4CAF50')
    
    # Unique constraint: one role ID per business
    __table_args__ = (db.UniqueConstraint('role_id', 'business_db_id', name='unique_role_per_business'),)
    
    def __repr__(self):
        return f'<DBRole {self.role_id}: {self.name}>'
    
    def to_dict(self):
        return {
            'id': self.role_id,
            'name': self.name,
            'color': self.color
        }


class DBEmployee(db.Model):
    """Persisted employee data for a business."""
    __tablename__ = 'db_employees'
    
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.String(50), nullable=False)  # e.g., "emp_abc123"
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    
    # Basic info
    name = db.Column(db.String(200), nullable=False)
    email = db.Column(db.String(200), nullable=True)
    phone = db.Column(db.String(50), nullable=True)
    color = db.Column(db.String(20), default='#4CAF50')
    
    # Classification: 'full_time' or 'part_time'
    classification = db.Column(db.String(20), default='part_time')
    
    # Hour constraints
    min_hours = db.Column(db.Integer, default=15)
    max_hours = db.Column(db.Integer, default=25)
    
    # Roles (comma-separated role IDs)
    roles = db.Column(db.Text, default='')
    
    # Supervision
    needs_supervision = db.Column(db.Boolean, default=False)
    can_supervise = db.Column(db.Boolean, default=False)
    
    # Overtime
    overtime_allowed = db.Column(db.Boolean, default=False)
    
    # Cost tracking
    hourly_rate = db.Column(db.Float, default=15.0)
    weekend_shifts_worked = db.Column(db.Integer, default=0)

    # Notification preferences (employee can change these in their portal)
    notify_email = db.Column(db.Boolean, default=True)
    notify_sms = db.Column(db.Boolean, default=True)

    # Availability stored as JSON
    # Format: {"availability": [{"day": 0, "hour": 8}, ...], "preferences": [...], "time_off": [...]}
    availability_json = db.Column(db.Text, default='{}')

    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Unique constraint: one employee ID per business
    __table_args__ = (db.UniqueConstraint('employee_id', 'business_db_id', name='unique_employee_per_business'),)

    def __repr__(self):
        return f'<DBEmployee {self.employee_id}: {self.name}>'
    
    def get_roles_list(self):
        """Get roles as a list of strings."""
        if not self.roles:
            return []
        return [r.strip() for r in self.roles.split(',') if r.strip()]
    
    def set_roles_list(self, roles):
        """Set roles from a list of strings."""
        self.roles = ','.join(roles)
    
    def get_availability_data(self):
        """Get availability as a dictionary."""
        if not self.availability_json:
            return {'availability': [], 'preferences': [], 'time_off': []}
        try:
            return json.loads(self.availability_json)
        except json.JSONDecodeError:
            return {'availability': [], 'preferences': [], 'time_off': []}
    
    def set_availability_data(self, data):
        """Set availability from a dictionary."""
        self.availability_json = json.dumps(data)
    
    def to_dict(self):
        avail_data = self.get_availability_data()
        return {
            'id': self.employee_id,
            'db_id': self.id,  # Database primary key for API calls
            'name': self.name,
            'email': self.email,
            'phone': self.phone,
            'color': self.color,
            'classification': self.classification,
            'min_hours': self.min_hours,
            'max_hours': self.max_hours,
            'roles': self.get_roles_list(),
            'needs_supervision': self.needs_supervision,
            'can_supervise': self.can_supervise,
            'overtime_allowed': self.overtime_allowed,
            'hourly_rate': self.hourly_rate,
            'weekend_shifts_worked': self.weekend_shifts_worked,
            'notify_email': self.notify_email if self.notify_email is not None else True,
            'notify_sms': self.notify_sms if self.notify_sms is not None else True,
            'availability': avail_data.get('availability', []),
            'preferences': avail_data.get('preferences', []),
            'time_off': avail_data.get('time_off', [])
        }


class DBShiftTemplate(db.Model):
    """Persisted shift template for a business."""
    __tablename__ = 'db_shift_templates'
    
    id = db.Column(db.Integer, primary_key=True)
    shift_id = db.Column(db.String(50), nullable=False)  # e.g., "morning", "afternoon"
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    
    name = db.Column(db.String(100), nullable=False)
    start_hour = db.Column(db.Integer, nullable=False)
    end_hour = db.Column(db.Integer, nullable=False)
    color = db.Column(db.String(20), default='#6366f1')
    
    # Days this shift applies (comma-separated day indices)
    days = db.Column(db.String(50), default='0,1,2,3,4,5,6')
    
    # Role requirements stored as JSON
    # Format: [{"role_id": "barista", "count": 1, "max_count": 2}, ...]
    roles_json = db.Column(db.Text, default='[]')
    
    # Unique constraint
    __table_args__ = (db.UniqueConstraint('shift_id', 'business_db_id', name='unique_shift_per_business'),)
    
    def __repr__(self):
        return f'<DBShiftTemplate {self.shift_id}: {self.name}>'
    
    def get_days_list(self):
        """Get days as a list of integers."""
        if not self.days:
            return []
        return [int(d) for d in self.days.split(',') if d]
    
    def set_days_list(self, days):
        """Set days from a list of integers."""
        self.days = ','.join(str(d) for d in days)
    
    def get_roles_requirements(self):
        """Get role requirements as a list."""
        if not self.roles_json:
            return []
        try:
            return json.loads(self.roles_json)
        except json.JSONDecodeError:
            return []
    
    def set_roles_requirements(self, roles):
        """Set role requirements from a list."""
        self.roles_json = json.dumps(roles)
    
    def to_dict(self):
        return {
            'id': self.shift_id,
            'name': self.name,
            'start_hour': self.start_hour,
            'end_hour': self.end_hour,
            'color': self.color,
            'days': self.get_days_list(),
            'roles': self.get_roles_requirements(),
            'duration': self.end_hour - self.start_hour
        }


class DBSchedule(db.Model):
    """Persisted generated schedule for a business."""
    __tablename__ = 'db_schedules'
    
    id = db.Column(db.Integer, primary_key=True)
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    
    # Week identifier (ISO week format: YYYY-WNN)
    week_id = db.Column(db.String(20), nullable=False, index=True)
    week_start_date = db.Column(db.Date, nullable=False)
    
    # Status: 'draft', 'published'
    status = db.Column(db.String(20), default='draft')
    
    # Schedule data stored as JSON (full schedule output)
    schedule_json = db.Column(db.Text, nullable=False)
    
    # Metrics
    coverage_percentage = db.Column(db.Float, default=0.0)
    total_hours_needed = db.Column(db.Integer, default=0)
    total_hours_filled = db.Column(db.Integer, default=0)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    published_at = db.Column(db.DateTime, nullable=True)
    
    # Unique constraint: one schedule per business per week
    __table_args__ = (db.UniqueConstraint('business_db_id', 'week_id', name='unique_schedule_per_week'),)
    
    def __repr__(self):
        return f'<DBSchedule {self.week_id} for business {self.business_db_id}>'
    
    def get_schedule_data(self):
        """Get schedule as a dictionary."""
        if not self.schedule_json:
            return {}
        try:
            return json.loads(self.schedule_json)
        except json.JSONDecodeError:
            return {}
    
    def set_schedule_data(self, data):
        """Set schedule from a dictionary."""
        self.schedule_json = json.dumps(data)
    
    def to_dict(self):
        return {
            'id': self.id,
            'week_id': self.week_id,
            'week_start_date': self.week_start_date.isoformat() if self.week_start_date else None,
            'status': self.status,
            'coverage_percentage': self.coverage_percentage,
            'total_hours_needed': self.total_hours_needed,
            'total_hours_filled': self.total_hours_filled,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'published_at': self.published_at.isoformat() if self.published_at else None,
            'schedule': self.get_schedule_data()
        }


class DBShiftAssignment(db.Model):
    """Individual shift assignment in a schedule (for querying individual shifts)."""
    __tablename__ = 'db_shift_assignments'
    
    id = db.Column(db.Integer, primary_key=True)
    schedule_id = db.Column(db.Integer, db.ForeignKey('db_schedules.id', ondelete='CASCADE'), nullable=False)
    
    employee_id = db.Column(db.String(50), nullable=False)
    employee_name = db.Column(db.String(200), nullable=False)
    
    day = db.Column(db.Integer, nullable=False)  # 0-6
    start_hour = db.Column(db.Integer, nullable=False)
    end_hour = db.Column(db.Integer, nullable=False)
    role_id = db.Column(db.String(50), default='')
    color = db.Column(db.String(20), default='#4CAF50')
    
    # Relationship
    schedule = db.relationship('DBSchedule', backref=db.backref('assignments', lazy=True, cascade='all, delete-orphan'))
    
    def __repr__(self):
        return f'<DBShiftAssignment {self.employee_name} day={self.day} {self.start_hour}-{self.end_hour}>'
    
    def to_dict(self):
        return {
            'employee_id': self.employee_id,
            'employee_name': self.employee_name,
            'day': self.day,
            'start_hour': self.start_hour,
            'end_hour': self.end_hour,
            'duration': self.end_hour - self.start_hour,
            'role_id': self.role_id,
            'color': self.color
        }


class ShiftSwapRequest(db.Model):
    """Shift swap request from an employee."""
    __tablename__ = 'shift_swap_requests'
    
    id = db.Column(db.Integer, primary_key=True)
    request_id = db.Column(db.String(20), unique=True, nullable=False, default=generate_uuid)
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    requester_employee_id = db.Column(db.String(50), nullable=False)
    
    # The shift being offered (the one requester wants to give away)
    original_day = db.Column(db.Integer, nullable=False)  # 0-6
    original_start_hour = db.Column(db.Integer, nullable=False)
    original_end_hour = db.Column(db.Integer, nullable=False)
    original_role_id = db.Column(db.String(50), nullable=True)
    
    # Week identifier
    week_start_date = db.Column(db.Date, nullable=False)
    
    # Status: 'pending', 'accepted', 'declined', 'expired', 'cancelled'
    status = db.Column(db.String(20), default='pending')
    
    # Note from requester
    note = db.Column(db.Text, nullable=True)
    
    # Whether the requester is open to receiving shifts in return (swap) vs just giving away
    open_for_swaps = db.Column(db.Boolean, default=False)
    
    # Who accepted (if accepted)
    accepted_by_employee_id = db.Column(db.String(50), nullable=True)
    
    # If accepter had to swap (their shift they're giving up)
    swap_day = db.Column(db.Integer, nullable=True)
    swap_start_hour = db.Column(db.Integer, nullable=True)
    swap_end_hour = db.Column(db.Integer, nullable=True)
    swap_role_id = db.Column(db.String(50), nullable=True)
    
    # Counter offer tracking - if this is a counter offer, links to original request
    counter_offer_for_id = db.Column(db.Integer, db.ForeignKey('shift_swap_requests.id'), nullable=True)
    is_counter_offer = db.Column(db.Boolean, default=False)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=True)
    resolved_at = db.Column(db.DateTime, nullable=True)
    
    # Relationship
    business = db.relationship('DBBusiness', backref=db.backref('swap_requests', lazy=True))
    recipients = db.relationship('SwapRequestRecipient', backref='swap_request', lazy=True, cascade='all, delete-orphan')
    
    def __repr__(self):
        return f'<ShiftSwapRequest {self.request_id} from {self.requester_employee_id}>'
    
    def to_dict(self):
        return {
            'id': self.request_id,
            'requester_employee_id': self.requester_employee_id,
            'original_day': self.original_day,
            'original_start_hour': self.original_start_hour,
            'original_end_hour': self.original_end_hour,
            'original_role_id': self.original_role_id,
            'week_start_date': self.week_start_date.isoformat() if self.week_start_date else None,
            'status': self.status,
            'note': self.note,
            'open_for_swaps': self.open_for_swaps or False,
            'accepted_by_employee_id': self.accepted_by_employee_id,
            'swap_day': self.swap_day,
            'swap_start_hour': self.swap_start_hour,
            'swap_end_hour': self.swap_end_hour,
            'swap_role_id': self.swap_role_id,
            'is_counter_offer': self.is_counter_offer or False,
            'counter_offer_for_id': self.counter_offer_for_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'expires_at': self.expires_at.isoformat() if self.expires_at else None,
            'resolved_at': self.resolved_at.isoformat() if self.resolved_at else None,
            'recipients': [r.to_dict() for r in self.recipients]
        }


class SwapRequestRecipient(db.Model):
    """Track who was notified about a swap request."""
    __tablename__ = 'swap_request_recipients'
    
    id = db.Column(db.Integer, primary_key=True)
    swap_request_id = db.Column(db.Integer, db.ForeignKey('shift_swap_requests.id', ondelete='CASCADE'), nullable=False)
    employee_id = db.Column(db.String(50), nullable=False)
    
    # Eligibility type: 'pickup' (can just take it) or 'swap_only' (must swap)
    eligibility_type = db.Column(db.String(20), default='pickup')
    
    # Notification tracking
    notified_at = db.Column(db.DateTime, nullable=True)
    notification_method = db.Column(db.String(20), nullable=True)  # 'email', 'sms', 'both'
    
    # Response: 'pending', 'accepted', 'declined', 'counter'
    response = db.Column(db.String(20), default='pending')
    responded_at = db.Column(db.DateTime, nullable=True)
    
    def __repr__(self):
        return f'<SwapRequestRecipient {self.employee_id} for request {self.swap_request_id}>'
    
    def to_dict(self):
        return {
            'employee_id': self.employee_id,
            'eligibility_type': self.eligibility_type,
            'notified_at': self.notified_at.isoformat() if self.notified_at else None,
            'notification_method': self.notification_method,
            'response': self.response,
            'responded_at': self.responded_at.isoformat() if self.responded_at else None
        }


class PasswordResetToken(db.Model):
    """Token for password reset requests."""
    __tablename__ = 'password_reset_tokens'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    token = db.Column(db.String(100), unique=True, nullable=False, index=True)
    
    # Expiration
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    used_at = db.Column(db.DateTime, nullable=True)
    
    # Relationship
    user = db.relationship('User', backref=db.backref('reset_tokens', lazy=True))
    
    def __repr__(self):
        return f'<PasswordResetToken for user {self.user_id}>'
    
    def is_valid(self):
        """Check if token is still valid (not expired, not used)."""
        from datetime import datetime
        return self.used_at is None and self.expires_at > datetime.utcnow()


class PTORequest(db.Model):
    """PTO / Time-off request from an employee."""
    __tablename__ = 'pto_requests'
    
    id = db.Column(db.Integer, primary_key=True)
    request_id = db.Column(db.String(20), unique=True, nullable=False, default=generate_uuid)
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id', ondelete='CASCADE'), nullable=False)
    employee_id = db.Column(db.String(50), nullable=False)
    
    # Date range for PTO (single day or multi-day)
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)  # Same as start_date for single days
    
    # Type: 'vacation', 'sick', 'personal', 'other'
    pto_type = db.Column(db.String(20), default='vacation')
    
    # Status: 'pending', 'approved', 'denied', 'cancelled'
    status = db.Column(db.String(20), default='pending')
    
    # Notes
    employee_note = db.Column(db.Text, nullable=True)
    manager_note = db.Column(db.Text, nullable=True)  # Reason for denial, etc.
    
    # Who reviewed it
    reviewed_by_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    reviewed_at = db.Column(db.DateTime, nullable=True)
    
    # Relationships
    business = db.relationship('DBBusiness', backref=db.backref('pto_requests', lazy=True))
    reviewed_by = db.relationship('User', backref=db.backref('reviewed_pto_requests', lazy=True))
    
    def __repr__(self):
        return f'<PTORequest {self.request_id} from {self.employee_id}>'
    
    def to_dict(self):
        return {
            'id': self.request_id,
            'employee_id': self.employee_id,
            'start_date': self.start_date.isoformat() if self.start_date else None,
            'end_date': self.end_date.isoformat() if self.end_date else None,
            'pto_type': self.pto_type,
            'status': self.status,
            'employee_note': self.employee_note,
            'manager_note': self.manager_note,
            'reviewed_by_id': self.reviewed_by_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'reviewed_at': self.reviewed_at.isoformat() if self.reviewed_at else None
        }


class ScheduleJob(db.Model):
    """A background schedule-generation job.

    Generation runs in a worker thread so the HTTP request returns immediately
    and the browser can poll for progress. Storing the job in the database (not
    in process memory) means the poll can be answered by any Gunicorn worker.
    """
    __tablename__ = 'schedule_jobs'

    id = db.Column(db.String(36), primary_key=True)  # uuid4
    business_id = db.Column(db.String(100), nullable=False, index=True)
    owner_id = db.Column(db.Integer, nullable=True)  # None for demo jobs
    week_start = db.Column(db.Date, nullable=False)
    kind = db.Column(db.String(20), default='generate')  # 'generate' | 'alternative'

    # 'queued' | 'running' | 'done' | 'failed'
    status = db.Column(db.String(20), default='queued', index=True)
    message = db.Column(db.Text, nullable=True)        # human-readable progress line
    progress_json = db.Column(db.Text, nullable=True)  # {"solutions": n, "unfilled_slots": n, "elapsed": s, ...}
    result_json = db.Column(db.Text, nullable=True)    # full response payload when done
    error = db.Column(db.Text, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def get_progress(self):
        if not self.progress_json:
            return {}
        try:
            return json.loads(self.progress_json)
        except json.JSONDecodeError:
            return {}

    def get_result(self):
        if not self.result_json:
            return None
        try:
            return json.loads(self.result_json)
        except json.JSONDecodeError:
            return None

    def to_dict(self, include_result=True):
        data = {
            'job_id': self.id,
            'business_id': self.business_id,
            'week_start': self.week_start.isoformat() if self.week_start else None,
            'kind': self.kind,
            'status': self.status,
            'message': self.message,
            'progress': self.get_progress(),
            'error': self.error,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
        if include_result and self.status == 'done':
            data['result'] = self.get_result()
        return data


def init_db(app):
    """Initialize the database with the Flask app."""
    db.init_app(app)
    bcrypt.init_app(app)

    with app.app_context():
        db.create_all()

        # Run migrations to add any missing columns
        _run_migrations(app)


# Columns added after the original tables were created. `create_all` never
# alters existing tables, so each deploy checks these and adds what is missing.
# Format: (table, column, SQL type/default clause)
_COLUMN_MIGRATIONS = [
    ('users', 'linked_employee_id', 'INTEGER REFERENCES db_employees(id)'),
    ('users', 'must_change_password', 'BOOLEAN DEFAULT FALSE'),
    ('users', 'promo_code', 'VARCHAR(40)'),
    ('businesses', 'coverage_config_json', 'TEXT'),
    ('db_employees', 'notify_email', 'BOOLEAN DEFAULT TRUE'),
    ('db_employees', 'notify_sms', 'BOOLEAN DEFAULT TRUE'),
    ('shift_swap_requests', 'open_for_swaps', 'BOOLEAN DEFAULT FALSE'),
    ('shift_swap_requests', 'counter_offer_for_id', 'INTEGER REFERENCES shift_swap_requests(id)'),
    ('shift_swap_requests', 'is_counter_offer', 'BOOLEAN DEFAULT FALSE'),
]


def _run_migrations(app):
    """Add any columns that exist in the models but not yet in the database."""
    from sqlalchemy import text, inspect

    try:
        inspector = inspect(db.engine)
        tables = set(inspector.get_table_names())
        migrations_run = []

        for table, column, ddl in _COLUMN_MIGRATIONS:
            if table not in tables:
                continue
            existing = {col['name'] for col in inspector.get_columns(table)}
            if column in existing:
                continue
            try:
                db.session.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}'))
                db.session.commit()
                migrations_run.append(f'{table}.{column}')
            except Exception as e:
                db.session.rollback()
                print(f"[DB MIGRATION] Warning adding {table}.{column}: {e}", flush=True)

        if migrations_run:
            print(f"[DB MIGRATION] Added columns: {migrations_run}", flush=True)

        # PostgreSQL only: make sure child rows are removed when a business is deleted
        if db.engine.dialect.name == 'postgresql':
            _migrate_cascade_foreign_keys(app)

    except Exception as e:
        print(f"[DB MIGRATION] Warning during migration check: {e}", flush=True)


def _migrate_cascade_foreign_keys(app):
    """Add ON DELETE CASCADE / SET NULL to existing foreign key constraints.
    
    SQLAlchemy's ondelete parameter only affects table creation, not existing tables.
    This migration drops and recreates FK constraints with the proper ON DELETE behavior.
    """
    from sqlalchemy import text
    
    # Each entry: (constraint_name, table, column, references_table, references_column, on_delete)
    fk_migrations = [
        ('db_roles_business_db_id_fkey', 'db_roles', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('db_employees_business_db_id_fkey', 'db_employees', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('db_shift_templates_business_db_id_fkey', 'db_shift_templates', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('db_schedules_business_db_id_fkey', 'db_schedules', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('db_shift_assignments_schedule_id_fkey', 'db_shift_assignments', 'schedule_id', 'db_schedules', 'id', 'CASCADE'),
        ('shift_swap_requests_business_db_id_fkey', 'shift_swap_requests', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('swap_request_recipients_swap_request_id_fkey', 'swap_request_recipients', 'swap_request_id', 'shift_swap_requests', 'id', 'CASCADE'),
        ('pto_requests_business_db_id_fkey', 'pto_requests', 'business_db_id', 'businesses', 'id', 'CASCADE'),
        ('users_linked_employee_id_fkey', 'users', 'linked_employee_id', 'db_employees', 'id', 'SET NULL'),
    ]
    
    migrations_run = []
    
    for constraint_name, table, column, ref_table, ref_column, on_delete in fk_migrations:
        try:
            # Check if the constraint exists and what its current ON DELETE action is
            result = db.session.execute(text("""
                SELECT rc.delete_rule
                FROM information_schema.referential_constraints rc
                JOIN information_schema.table_constraints tc
                    ON rc.constraint_name = tc.constraint_name
                WHERE tc.table_name = :table_name
                  AND tc.constraint_name = :constraint_name
            """), {'table_name': table, 'constraint_name': constraint_name})
            
            row = result.fetchone()
            if row is None:
                # Constraint doesn't exist or has a different name, skip
                continue
            
            current_action = row[0]  # e.g., 'NO ACTION', 'CASCADE', 'SET NULL'
            expected_action = on_delete.replace(' ', ' ')  # 'CASCADE' or 'SET NULL'
            
            if current_action == expected_action:
                continue  # Already correct
            
            # Drop old constraint and recreate with ON DELETE CASCADE/SET NULL
            db.session.execute(text(
                f'ALTER TABLE {table} DROP CONSTRAINT {constraint_name}'
            ))
            db.session.execute(text(
                f'ALTER TABLE {table} ADD CONSTRAINT {constraint_name} '
                f'FOREIGN KEY ({column}) REFERENCES {ref_table}({ref_column}) ON DELETE {on_delete}'
            ))
            db.session.commit()
            migrations_run.append(f'{table}.{column} -> ON DELETE {on_delete}')
            
        except Exception as e:
            db.session.rollback()
            print(f"[DB MIGRATION] Warning updating FK {constraint_name}: {e}", flush=True)
    
    if migrations_run:
        print(f"[DB MIGRATION] Updated foreign key cascades: {migrations_run}", flush=True)