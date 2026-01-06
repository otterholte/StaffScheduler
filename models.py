"""Database models for user authentication and business settings."""

from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from flask_bcrypt import Bcrypt
import json

db = SQLAlchemy()
bcrypt = Bcrypt()


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


def init_db(app):
    """Initialize the database with the Flask app."""
    db.init_app(app)
    bcrypt.init_app(app)
    
    with app.app_context():
        db.create_all()
