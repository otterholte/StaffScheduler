"""
Database migration script to add missing columns to production database.
Run this once to sync the database schema with the models.

Usage: python migrate_db.py
"""

import os
from sqlalchemy import create_engine, text, inspect
from dotenv import load_dotenv

load_dotenv()

def get_database_url():
    """Get and normalize the database URL."""
    url = os.environ.get('DATABASE_URL', 'sqlite:///staffscheduler.db')
    if url and url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    return url

def run_migrations():
    """Run database migrations to add missing columns."""
    db_url = get_database_url()
    print(f"Connecting to database...")
    
    engine = create_engine(db_url)
    inspector = inspect(engine)
    
    with engine.connect() as conn:
        # Check existing columns in users table
        existing_columns = [col['name'] for col in inspector.get_columns('users')]
        print(f"Existing columns in users table: {existing_columns}")
        
        migrations = []
        
        # Migration 1: Add linked_employee_id column
        if 'linked_employee_id' not in existing_columns:
            migrations.append({
                'name': 'Add linked_employee_id to users',
                'sql': 'ALTER TABLE users ADD COLUMN linked_employee_id INTEGER REFERENCES db_employees(id)'
            })
        
        # Migration 2: Add must_change_password column
        if 'must_change_password' not in existing_columns:
            migrations.append({
                'name': 'Add must_change_password to users',
                'sql': 'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT FALSE'
            })
        
        if not migrations:
            print("✅ Database schema is up to date. No migrations needed.")
            return
        
        print(f"\n📋 Found {len(migrations)} migration(s) to run:\n")
        
        for migration in migrations:
            print(f"  Running: {migration['name']}...")
            try:
                conn.execute(text(migration['sql']))
                conn.commit()
                print(f"  ✅ Success: {migration['name']}")
            except Exception as e:
                print(f"  ❌ Error: {e}")
                # Continue with other migrations
        
        print("\n✅ Migrations complete!")

if __name__ == '__main__':
    run_migrations()

