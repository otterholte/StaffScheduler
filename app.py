"""
Staff Scheduler - Flask application entry point.

Run locally with `python app.py`; in production Gunicorn imports `app` from
this module (see Procfile).

The app is split into small pieces:

    config.py                 environment-driven settings
    models.py                 SQLAlchemy tables
    auth.py                   login, registration, password reset
    routes/pages.py           HTML pages (landing, manager app, demo, employee portal)
    routes/manager_api.py     JSON API used by the manager app
    routes/schedule_api.py    schedule generation (background jobs), publish, load
    routes/employee_api.py    JSON API used by the employee portal
    services/                 business loading + access control, jobs, notifications
    scheduler/                the OR-Tools solver and its data models
"""

import os
import sys
import traceback

# Business names and emails can contain emoji; make sure logging never crashes
# on consoles that default to a narrow code page (Windows).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

from flask import Flask, jsonify, redirect, render_template, request
from flask_login import LoginManager
from werkzeug.exceptions import HTTPException

from auth import auth_bp
from config import get_config
from models import User, init_db
from routes import employee_api_bp, manager_api_bp, pages_bp, schedule_api_bp


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(get_config())

    # Behind Railway/Cloudflare the original scheme/host arrive in X-Forwarded-* headers
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    init_db(app)

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = 'Please log in to access this page.'
    login_manager.login_message_category = 'info'

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    @login_manager.unauthorized_handler
    def unauthorized():
        # API calls get JSON; pages get the login screen with a return path
        if request.path.startswith('/api/'):
            return jsonify({'success': False, 'message': 'Please sign in to continue.', 'error': 'unauthorized'}), 401
        return redirect(f"/auth/login?next={request.path}")

    app.register_blueprint(auth_bp, url_prefix='/auth')
    app.register_blueprint(pages_bp)
    app.register_blueprint(manager_api_bp)
    app.register_blueprint(schedule_api_bp)
    app.register_blueprint(employee_api_bp)

    _register_error_handlers(app)

    @app.after_request
    def no_cache_for_html(response):
        """HTML is always fresh; static assets are cache-busted by the templates."""
        if response.content_type and 'text/html' in response.content_type:
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
        return response

    return app


def _register_error_handlers(app: Flask):
    @app.errorhandler(404)
    def not_found(error):
        if request.path.startswith('/api/'):
            return jsonify({'success': False, 'message': 'Not found', 'error': 'not_found'}), 404
        return render_template('403.html', message="We couldn't find that page."), 404

    @app.errorhandler(Exception)
    def handle_exception(error):
        if isinstance(error, HTTPException):
            return error
        print("=" * 60, flush=True)
        print(f"[UNHANDLED] {type(error).__name__}: {error} at {request.method} {request.path}", flush=True)
        traceback.print_exc()
        print("=" * 60, flush=True)
        if request.path.startswith('/api/'):
            return jsonify({'success': False, 'message': 'Something went wrong on our end. Please try again.',
                            'error': 'server_error'}), 500
        return render_template('403.html', message="Something went wrong. Please try again."), 500


app = create_app()


if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    port = int(os.environ.get('PORT', 5000))
    print(f"\nStaff Scheduler running at http://localhost:{port}\n", flush=True)
    app.run(debug=debug_mode, host='0.0.0.0', port=port)
