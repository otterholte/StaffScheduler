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
    """User model for authentication."""
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    
    # Profile info
    first_name = db.Column(db.String(50), nullable=True)
    last_name = db.Column(db.String(50), nullable=True)
    company_name = db.Column(db.String(100), nullable=True)
    
    # Account status
    is_active = db.Column(db.Boolean, default=True)
    is_verified = db.Column(db.Boolean, default=False)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)
    
    def __repr__(self):
        return f'<User {self.username}>'
    
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
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id'), nullable=False)
    
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
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id'), nullable=False)
    
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
            'availability': avail_data.get('availability', []),
            'preferences': avail_data.get('preferences', []),
            'time_off': avail_data.get('time_off', [])
        }


class DBShiftTemplate(db.Model):
    """Persisted shift template for a business."""
    __tablename__ = 'db_shift_templates'
    
    id = db.Column(db.Integer, primary_key=True)
    shift_id = db.Column(db.String(50), nullable=False)  # e.g., "morning", "afternoon"
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id'), nullable=False)
    
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
    business_db_id = db.Column(db.Integer, db.ForeignKey('businesses.id'), nullable=False)
    
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
    schedule_id = db.Column(db.Integer, db.ForeignKey('db_schedules.id'), nullable=False)
    
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


def init_db(app):
    """Initialize the database with the Flask app."""
    db.init_app(app)
    bcrypt.init_app(app)
    
    with app.app_context():
        db.create_all()
