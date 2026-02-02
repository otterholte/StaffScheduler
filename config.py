"""Configuration settings for the Staff Scheduler application."""

import os
from dotenv import load_dotenv

load_dotenv()

# =============================================================================
# LOCAL TEST CREDENTIALS (for development/testing only)
# =============================================================================
# Email: ptotest@test.com
# Username: ptotestuser
# Password: TestPass123!
# Business: PTO Test Business (slug: pto-test-business)
# =============================================================================


def _get_database_url():
    """Get and normalize the database URL."""
    url = os.environ.get('DATABASE_URL', 'sqlite:///staffscheduler.db')
    # Railway historically uses postgres:// but SQLAlchemy needs postgresql://
    if url and url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    return url


def _get_engine_options(db_url):
    """Get SQLAlchemy engine options based on database type.
    
    PostgreSQL connections need pool management to handle:
    - Railway cold starts
    - Connection timeouts
    - Stale connections after idle periods
    """
    if db_url and db_url.startswith('postgresql://'):
        return {
            'pool_pre_ping': True,  # Verify connections before use (prevents stale conn errors)
            'pool_recycle': 300,    # Recycle connections every 5 minutes
            'pool_size': 5,         # Number of connections to keep open
            'max_overflow': 10,     # Allow up to 10 additional connections
        }
    return {}  # SQLite doesn't need pooling options


class Config:
    """Base configuration."""
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key-change-in-production'
    
    # Site URL for emails and external links
    SITE_URL = os.environ.get('SITE_URL', 'http://localhost:5000')
    
    # Email configuration
    MAIL_SERVER = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
    MAIL_PORT = int(os.environ.get('MAIL_PORT', 587))
    MAIL_USERNAME = os.environ.get('MAIL_USERNAME', '')
    MAIL_PASSWORD = os.environ.get('MAIL_PASSWORD', '')
    MAIL_FROM_NAME = os.environ.get('MAIL_FROM_NAME', 'Staff Scheduler')
    
    # Database configuration
    SQLALCHEMY_DATABASE_URI = _get_database_url()
    SQLALCHEMY_ENGINE_OPTIONS = _get_engine_options(SQLALCHEMY_DATABASE_URI)
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    
    # Session config
    SESSION_COOKIE_SECURE = os.environ.get('FLASK_ENV') == 'production'
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'


class DevelopmentConfig(Config):
    """Development configuration."""
    DEBUG = True
    TEMPLATES_AUTO_RELOAD = True


class ProductionConfig(Config):
    """Production configuration."""
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    SITE_URL = os.environ.get('SITE_URL', 'https://thestaffscheduler.com')


# Config selector
config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}


def get_config():
    """Get the appropriate configuration based on environment."""
    env = os.environ.get('FLASK_ENV', 'development')
    return config.get(env, config['default'])
