"""
Authentication: login, registration, logout, profile, password change/reset.

Mounted under /auth. Every page redirect goes through
`default_landing_url()` so managers land on their own business and employees
land on their portal (never on a demo business).
"""

import secrets
from datetime import datetime, timedelta
from urllib.parse import urlparse

from flask import Blueprint, flash, jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required, login_user, logout_user

from email_service import get_email_service
from models import db, PasswordResetToken, User
from services.business_context import default_landing_url, ensure_user_has_business
from services.common import site_url
import db_service

auth_bp = Blueprint('auth', __name__)

MIN_PASSWORD_LENGTH = 8


def _safe_next(default: str) -> str:
    """Only follow `next` if it is a path on this site (prevents open redirects)."""
    nxt = request.args.get('next') or request.form.get('next') or ''
    if nxt and nxt.startswith('/') and not nxt.startswith('//') and not urlparse(nxt).netloc:
        return nxt
    return default


def _form(*names):
    """Read fields from JSON or form data (both are supported)."""
    data = request.get_json(silent=True) if request.is_json else request.form
    data = data or {}
    return [(data.get(n) or '').strip() if isinstance(data.get(n), str) else data.get(n) for n in names]


# ---------------------------------------------------------------- login / logout

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(_safe_next(default_landing_url()))

    if request.method == 'POST':
        login_id, password, remember = _form('email', 'password', 'remember')
        login_id = (login_id or '').lower()

        user = User.query.filter_by(email=login_id).first() or User.query.filter(User.username.ilike(login_id)).first()
        if not user or not user.check_password(password or ''):
            if request.is_json:
                return jsonify({'success': False, 'error': 'Invalid username/email or password.'}), 401
            flash('Invalid username/email or password.', 'error')
            return render_template('login.html')
        if not user.is_active:
            if request.is_json:
                return jsonify({'success': False, 'error': 'Account is deactivated.'}), 403
            flash('Your account has been deactivated. Please contact support.', 'error')
            return render_template('login.html')

        login_user(user, remember=bool(remember))
        user.last_login = datetime.utcnow()
        db.session.commit()

        if user.must_change_password:
            destination = url_for('auth.change_password')
        else:
            destination = _safe_next(default_landing_url(user))

        if request.is_json:
            return jsonify({'success': True, 'user': user.to_dict(), 'redirect': destination,
                            'must_change_password': bool(user.must_change_password)})
        return redirect(destination)

    return render_template('login.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    flash('You have been logged out.', 'info')
    return redirect('/')


# ---------------------------------------------------------------- registration

@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(default_landing_url())

    if request.method == 'POST':
        email, username, password, confirm, first_name, last_name, company_name = _form(
            'email', 'username', 'password', 'confirm_password', 'first_name', 'last_name', 'company_name')
        email = (email or '').lower()

        errors = []
        if not email or '@' not in email or '.' not in email.split('@')[-1]:
            errors.append('Please enter a valid email address.')
        if not username or len(username) < 3:
            errors.append('Username must be at least 3 characters.')
        elif not all(c.isalnum() or c == '_' for c in username):
            errors.append('Username can only contain letters, numbers, and underscores.')
        if not password or len(password) < MIN_PASSWORD_LENGTH:
            errors.append(f'Password must be at least {MIN_PASSWORD_LENGTH} characters.')
        if password != confirm:
            errors.append('Passwords do not match.')
        if not company_name:
            errors.append('Please enter your business name.')
        if email and User.query.filter_by(email=email).first():
            errors.append('An account with this email already exists. Try signing in or resetting your password.')
        if username and User.query.filter(User.username.ilike(username)).first():
            errors.append('This username is already taken.')

        if errors:
            if request.is_json:
                return jsonify({'success': False, 'errors': errors}), 400
            for e in errors:
                flash(e, 'error')
            return render_template('register.html', form=request.form)

        user = User(email=email, username=username, first_name=first_name or None,
                    last_name=last_name or None, company_name=company_name)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        ensure_user_has_business(user)  # creates their first location
        login_user(user)
        user.last_login = datetime.utcnow()
        db.session.commit()

        destination = default_landing_url(user)
        if request.is_json:
            return jsonify({'success': True, 'user': user.to_dict(), 'redirect': destination,
                            'message': 'Account created successfully!'})
        flash('Welcome to Staff Scheduler! Add your staff and shifts to get started.', 'success')
        return redirect(destination)

    return render_template('register.html', form={})


# ---------------------------------------------------------------- profile API

@auth_bp.route('/api/user')
@login_required
def get_current_user():
    return jsonify({'success': True, 'user': current_user.to_dict()})


@auth_bp.route('/api/user', methods=['PUT'])
@login_required
def update_user():
    data = request.get_json(silent=True) or {}
    if 'first_name' in data:
        current_user.first_name = (data.get('first_name') or '').strip() or None
    if 'last_name' in data:
        current_user.last_name = (data.get('last_name') or '').strip() or None
    if 'company_name' in data and (data.get('company_name') or '').strip():
        current_user.company_name = data['company_name'].strip()

    if data.get('email') and data['email'].lower().strip() != current_user.email:
        new_email = data['email'].lower().strip()
        if User.query.filter_by(email=new_email).first():
            return jsonify({'success': False, 'error': 'Email already in use.'}), 400
        current_user.email = new_email

    if data.get('new_password'):
        if not current_user.check_password(data.get('current_password', '')):
            return jsonify({'success': False, 'error': 'Current password is incorrect.'}), 400
        if len(data['new_password']) < MIN_PASSWORD_LENGTH:
            return jsonify({'success': False, 'error': f'New password must be at least {MIN_PASSWORD_LENGTH} characters.'}), 400
        current_user.set_password(data['new_password'])

    db.session.commit()
    return jsonify({'success': True, 'user': current_user.to_dict(), 'message': 'Profile updated.'})


@auth_bp.route('/api/user', methods=['DELETE'])
@login_required
def delete_user_account():
    """Delete the account and every business it owns (password required)."""
    data = request.get_json(silent=True) or {}
    if not current_user.check_password(data.get('password', '')):
        return jsonify({'success': False, 'error': 'Incorrect password.'}), 400

    user_id, username = current_user.id, current_user.username
    logout_user()
    user = User.query.get(user_id)
    if user:
        for row in db_service.get_user_db_businesses(user.id):
            db_service.delete_business_from_db(row.business_id)
        from models import BusinessSettings, UserBusinessSettings
        BusinessSettings.query.filter_by(owner_id=user.id).delete()
        UserBusinessSettings.query.filter_by(user_id=user.id).delete()
        PasswordResetToken.query.filter_by(user_id=user.id).delete()
        db.session.delete(user)
        db.session.commit()
    return jsonify({'success': True, 'message': f'Account "{username}" has been deleted.'})


# ---------------------------------------------------------------- password change

@auth_bp.route('/change-password', methods=['GET', 'POST'])
@login_required
def change_password():
    """Forced on first login with a temporary password; also usable any time."""
    if request.method == 'POST':
        new_password, confirm = _form('new_password', 'confirm_password')
        errors = []
        if not new_password or len(new_password) < MIN_PASSWORD_LENGTH:
            errors.append(f'Password must be at least {MIN_PASSWORD_LENGTH} characters.')
        if new_password != confirm:
            errors.append('Passwords do not match.')
        if errors:
            if request.is_json:
                return jsonify({'success': False, 'errors': errors}), 400
            for e in errors:
                flash(e, 'error')
            return render_template('change_password.html')

        current_user.set_password(new_password)
        current_user.must_change_password = False
        db.session.commit()
        destination = default_landing_url(current_user)
        if request.is_json:
            return jsonify({'success': True, 'message': 'Password changed.', 'redirect': destination})
        flash('Password changed successfully!', 'success')
        return redirect(destination)

    return render_template('change_password.html')


# ---------------------------------------------------------------- password reset

@auth_bp.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if current_user.is_authenticated:
        return redirect(default_landing_url())

    if request.method == 'POST':
        (email,) = _form('email')
        email = (email or '').lower()
        if not email:
            flash('Please enter your email address.', 'error')
            return render_template('forgot_password.html')

        user = User.query.filter_by(email=email).first()
        if user:
            PasswordResetToken.query.filter_by(user_id=user.id, used_at=None).delete()
            token = secrets.token_urlsafe(32)
            db.session.add(PasswordResetToken(user_id=user.id, token=token,
                                              expires_at=datetime.utcnow() + timedelta(hours=1)))
            db.session.commit()

            reset_url = f"{site_url()}{url_for('auth.reset_password', token=token)}"
            svc = get_email_service()
            if svc.is_configured():
                ok, msg = svc.send_password_reset(user.email, user.first_name or user.username, reset_url)
                if not ok:
                    print(f"[AUTH] Password reset email failed for {user.email}: {msg}", flush=True)
            else:
                print(f"[AUTH] Email not configured. Reset link: {reset_url}", flush=True)

        # Same message either way so nobody can probe which emails exist
        flash("If an account with that email exists, we've sent a password reset link. Check your spam folder if it doesn't arrive within a few minutes.", 'success')
        return redirect(url_for('auth.login'))

    return render_template('forgot_password.html')


@auth_bp.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    if current_user.is_authenticated:
        return redirect(default_landing_url())

    reset_token = PasswordResetToken.query.filter_by(token=token).first()
    if not reset_token or not reset_token.is_valid():
        flash('This password reset link is invalid or has expired. Request a new one below.', 'error')
        return redirect(url_for('auth.forgot_password'))

    if request.method == 'POST':
        password, confirm = _form('password', 'confirm_password')
        errors = []
        if not password or len(password) < MIN_PASSWORD_LENGTH:
            errors.append(f'Password must be at least {MIN_PASSWORD_LENGTH} characters.')
        if password != confirm:
            errors.append('Passwords do not match.')
        if errors:
            for e in errors:
                flash(e, 'error')
            return render_template('reset_password.html', token=token)

        user = reset_token.user
        user.set_password(password)
        user.must_change_password = False
        reset_token.used_at = datetime.utcnow()
        db.session.commit()
        flash('Your password has been reset. You can now sign in.', 'success')
        return redirect(url_for('auth.login'))

    return render_template('reset_password.html', token=token)
