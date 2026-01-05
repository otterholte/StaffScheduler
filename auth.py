"""Authentication routes for user login, registration, and logout."""

from datetime import datetime
from flask import Blueprint, render_template, redirect, url_for, flash, request, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from models import db, User

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    """Handle user login."""
    # If already logged in, redirect to app dashboard
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        # Handle both form and JSON submissions
        if request.is_json:
            data = request.get_json()
            email = data.get('email', '').lower().strip()
            password = data.get('password', '')
            remember = data.get('remember', False)
        else:
            email = request.form.get('email', '').lower().strip()
            password = request.form.get('password', '')
            remember = request.form.get('remember', False)
        
        # Find user by email
        user = User.query.filter_by(email=email).first()
        
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
                    'redirect': url_for('index')
                })
            
            # Redirect to next page or home
            next_page = request.args.get('next')
            return redirect(next_page if next_page else url_for('index'))
        else:
            if request.is_json:
                return jsonify({'success': False, 'error': 'Invalid email or password.'}), 401
            flash('Invalid email or password.', 'error')
    
    return render_template('login.html')


@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    """Handle user registration."""
    # If already logged in, redirect to app
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
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
        
        # Log the user in immediately
        login_user(user)
        user.last_login = datetime.utcnow()
        db.session.commit()
        
        if request.is_json:
            return jsonify({
                'success': True,
                'user': user.to_dict(),
                'message': 'Account created successfully!',
                'redirect': url_for('index')
            })
        
        flash('Account created successfully! Welcome to Staff Scheduler Pro.', 'success')
        return redirect(url_for('index'))
    
    return render_template('register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    """Log out the current user."""
    logout_user()
    flash('You have been logged out.', 'info')
    return redirect(url_for('auth.login'))


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