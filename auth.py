"""Authentication routes for user login, registration, and logout."""

from datetime import datetime, timedelta
import secrets
from flask import Blueprint, render_template, redirect, url_for, flash, request, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from models import db, User, PasswordResetToken
from scheduler import create_user_business, get_user_business
from email_service import get_email_service

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    """Handle user login."""
    # If already logged in, redirect to app dashboard
    if current_user.is_authenticated:
        return redirect('/sunrise-coffee/schedule')
    
    if request.method == 'POST':
        # Handle both form and JSON submissions
        if request.is_json:
            data = request.get_json()
            login_id = data.get('email', '').strip()  # Can be email or username
            password = data.get('password', '')
            remember = data.get('remember', False)
        else:
            login_id = request.form.get('email', '').strip()  # Can be email or username
            password = request.form.get('password', '')
            remember = request.form.get('remember', False)
        
        # Find user by email or username
        # First try email (case-insensitive)
        user = User.query.filter_by(email=login_id.lower()).first()
        
        # If not found by email, try username (case-insensitive)
        if not user:
            user = User.query.filter(User.username.ilike(login_id)).first()
        
        if user and user.check_password(password):
            if not user.is_active:
                if request.is_json:
                    return jsonify({'success': False, 'error': 'Account is deactivated.'}), 403
                flash('Your account has been deactivated. Please contact support.', 'error')
                return render_template('login.html')
            
            # Log the user in
            login_user(user, remember=remember)
            user.last_login = datetime.utcnow()
            db.session.commit()
            
            if request.is_json:
                return jsonify({
                    'success': True, 
                    'user': user.to_dict(),
                    'redirect': '/sunrise-coffee/schedule'
                })
            
            # Redirect to next page or home
            next_page = request.args.get('next')
            return redirect(next_page if next_page else '/sunrise-coffee/schedule')
        else:
            if request.is_json:
                return jsonify({'success': False, 'error': 'Invalid username/email or password.'}), 401
            flash('Invalid username/email or password.', 'error')
    
    return render_template('login.html')


@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    """Handle user registration."""
    # If already logged in, redirect to app
    if current_user.is_authenticated:
        return redirect('/sunrise-coffee/schedule')
    
    if request.method == 'POST':
        # Handle both form and JSON submissions
        if request.is_json:
            data = request.get_json()
            email = data.get('email', '').lower().strip()
            username = data.get('username', '').strip()
            password = data.get('password', '')
            confirm_password = data.get('confirm_password', '')
            first_name = data.get('first_name', '').strip()
            last_name = data.get('last_name', '').strip()
            company_name = data.get('company_name', '').strip()
        else:
            email = request.form.get('email', '').lower().strip()
            username = request.form.get('username', '').strip()
            password = request.form.get('password', '')
            confirm_password = request.form.get('confirm_password', '')
            first_name = request.form.get('first_name', '').strip()
            last_name = request.form.get('last_name', '').strip()
            company_name = request.form.get('company_name', '').strip()
        
        errors = []
        
        # Validation
        if not email:
            errors.append('Email is required.')
        elif '@' not in email or '.' not in email:
            errors.append('Please enter a valid email address.')
        
        if not username:
            errors.append('Username is required.')
        elif len(username) < 3:
            errors.append('Username must be at least 3 characters.')
        elif not username.isalnum() and '_' not in username:
            errors.append('Username can only contain letters, numbers, and underscores.')
        
        if not password:
            errors.append('Password is required.')
        elif len(password) < 8:
            errors.append('Password must be at least 8 characters.')
        
        if password != confirm_password:
            errors.append('Passwords do not match.')
        
        # Check if email already exists
        if User.query.filter_by(email=email).first():
            errors.append('An account with this email already exists.')
        
        # Check if username already exists
        if User.query.filter_by(username=username).first():
            errors.append('This username is already taken.')
        
        if errors:
            if request.is_json:
                return jsonify({'success': False, 'errors': errors}), 400
            for error in errors:
                flash(error, 'error')
            return render_template('register.html')
        
        # Create new user
        user = User(
            email=email,
            username=username,
            first_name=first_name or None,
            last_name=last_name or None,
            company_name=company_name or None
        )
        user.set_password(password)
        
        db.session.add(user)
        db.session.commit()
        
        # If user provided a company name, create their business
        redirect_url = '/sunrise-coffee/schedule'
        if company_name:
            owner_name = f"{first_name} {last_name}".strip() if first_name or last_name else username
            business = create_user_business(user.id, company_name, owner_name)
            # Generate the slug for their business (same logic as app.py slugify)
            import re
            slug = company_name.lower().strip()
            slug = re.sub(r'[^\w\s-]', '', slug)
            slug = re.sub(r'[\s_]+', '-', slug)
            slug = re.sub(r'-+', '-', slug)
            redirect_url = f'/{slug}/schedule'
        
        # Log the user in immediately
        login_user(user)
        user.last_login = datetime.utcnow()
        db.session.commit()
        
        if request.is_json:
            return jsonify({
                'success': True,
                'user': user.to_dict(),
                'message': 'Account created successfully!',
                'redirect': redirect_url
            })
        
        flash('Account created successfully! Welcome to Staff Scheduler Pro.', 'success')
        return redirect(redirect_url)
    
    return render_template('register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    """Log out the current user."""
    logout_user()
    # Get the referrer to determine where to redirect
    referrer = request.referrer or ''
    # If logging out from settings page, stay on settings
    if '/settings' in referrer:
        flash('You have been logged out.', 'info')
        return redirect('/settings')
    flash('You have been logged out.', 'info')
    return redirect('/settings')


@auth_bp.route('/api/user')
@login_required
def get_current_user():
    """Get the current logged-in user's information."""
    return jsonify({
        'success': True,
        'user': current_user.to_dict()
    })


@auth_bp.route('/api/user', methods=['PUT'])
@login_required
def update_user():
    """Update the current user's profile."""
    data = request.get_json()
    
    if 'first_name' in data:
        current_user.first_name = data['first_name'].strip() or None
    if 'last_name' in data:
        current_user.last_name = data['last_name'].strip() or None
    if 'company_name' in data:
        current_user.company_name = data['company_name'].strip() or None
    
    # Handle email change
    if 'email' in data and data['email'] != current_user.email:
        new_email = data['email'].lower().strip()
        if User.query.filter_by(email=new_email).first():
            return jsonify({'success': False, 'error': 'Email already in use.'}), 400
        current_user.email = new_email
    
    # Handle password change
    if 'new_password' in data and data['new_password']:
        current_password = data.get('current_password', '')
        if not current_user.check_password(current_password):
            return jsonify({'success': False, 'error': 'Current password is incorrect.'}), 400
        if len(data['new_password']) < 8:
            return jsonify({'success': False, 'error': 'New password must be at least 8 characters.'}), 400
        current_user.set_password(data['new_password'])
    
    db.session.commit()
    
    return jsonify({
        'success': True,
        'user': current_user.to_dict(),
        'message': 'Profile updated successfully.'
    })




@auth_bp.route('/api/user', methods=['DELETE'])
@login_required
def delete_user_account():
    """Delete the current user's account."""
    data = request.get_json() or {}
    password = data.get('password', '')
    
    # Require password confirmation for account deletion
    if not current_user.check_password(password):
        return jsonify({'success': False, 'error': 'Incorrect password.'}), 400
    
    user_id = current_user.id
    username = current_user.username
    
    # Log out the user first
    logout_user()
    
    # Delete the user from the database
    user = User.query.get(user_id)
    if user:
        db.session.delete(user)
        db.session.commit()
    
    return jsonify({
        'success': True,
        'message': f'Account "{username}" has been deleted.'
    })


@auth_bp.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    """Handle forgot password requests."""
    if current_user.is_authenticated:
        return redirect('/sunrise-coffee/schedule')
    
    if request.method == 'POST':
        email = request.form.get('email', '').lower().strip()
        
        if not email:
            flash('Please enter your email address.', 'error')
            return render_template('forgot_password.html')
        
        # Find user by email
        user = User.query.filter_by(email=email).first()
        
        # Always show success message to prevent email enumeration
        if user:
            # Delete any existing unused tokens for this user
            PasswordResetToken.query.filter_by(user_id=user.id, used_at=None).delete()
            
            # Create new token
            token = secrets.token_urlsafe(32)
            reset_token = PasswordResetToken(
                user_id=user.id,
                token=token,
                expires_at=datetime.utcnow() + timedelta(hours=1)
            )
            db.session.add(reset_token)
            db.session.commit()
            
            # Send email
            email_service = get_email_service()
            if email_service.is_configured():
                reset_url = request.host_url.rstrip('/') + url_for('auth.reset_password', token=token)
                user_name = user.first_name or user.username
                success, msg = email_service.send_password_reset(user.email, user_name, reset_url)
                if not success:
                    print(f"[AUTH] Password reset email failed: {msg}", flush=True)
            else:
                print(f"[AUTH] Email not configured, reset token: {token}", flush=True)
        
        flash('If an account with that email exists, we\'ve sent a password reset link.', 'success')
        return redirect(url_for('auth.login'))
    
    return render_template('forgot_password.html')


@auth_bp.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    """Handle password reset with token."""
    if current_user.is_authenticated:
        return redirect('/sunrise-coffee/schedule')
    
    # Find and validate token
    reset_token = PasswordResetToken.query.filter_by(token=token).first()
    
    if not reset_token or not reset_token.is_valid():
        flash('This password reset link is invalid or has expired.', 'error')
        return redirect(url_for('auth.forgot_password'))
    
    if request.method == 'POST':
        password = request.form.get('password', '')
        confirm_password = request.form.get('confirm_password', '')
        
        errors = []
        
        if not password:
            errors.append('Password is required.')
        elif len(password) < 8:
            errors.append('Password must be at least 8 characters.')
        
        if password != confirm_password:
            errors.append('Passwords do not match.')
        
        if errors:
            for error in errors:
                flash(error, 'error')
            return render_template('reset_password.html', token=token)
        
        # Update password
        user = reset_token.user
        user.set_password(password)
        
        # Mark token as used
        reset_token.used_at = datetime.utcnow()
        db.session.commit()
        
        flash('Your password has been reset. You can now log in.', 'success')
        return redirect(url_for('auth.login'))
    
    return render_template('reset_password.html', token=token)