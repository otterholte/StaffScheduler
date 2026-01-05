from app import app
from models import db, User
import sys

print("--- DB DIAGNOSTICS ---")
print(f"Python version: {sys.version}")

with app.app_context():
    try:
        count = User.query.count()
        print(f"User count: {count}")
        users = User.query.all()
        for u in users:
            print(f"User: {u.username} ({u.email})")
    except Exception as e:
        print(f"DB Error: {e}")
        import traceback
        traceback.print_exc()

print("--- CONFIG DIAGNOSTICS ---")
for key in ['SQLALCHEMY_DATABASE_URI', 'SECRET_KEY', 'DEBUG', 'ENV', 'FLASK_ENV']:
    print(f"{key}: {app.config.get(key)}")

