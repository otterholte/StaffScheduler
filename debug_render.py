from flask import Flask, render_template
from models import db, User, init_db
import os

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = 'test'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///instance/staffscheduler.db'

# Use an app context
with app.app_context():
    init_db(app)
    try:
        print("Attempting to render settings.html...")
        html = render_template('settings.html', user=None)
        print("Success!")
    except Exception as e:
        import traceback
        print(f"Error: {e}")
        traceback.print_exc()







