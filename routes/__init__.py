"""Flask blueprints, one per area of the product."""

from .pages import pages_bp
from .manager_api import manager_api_bp
from .schedule_api import schedule_api_bp
from .employee_api import employee_api_bp

__all__ = ['pages_bp', 'manager_api_bp', 'schedule_api_bp', 'employee_api_bp']
