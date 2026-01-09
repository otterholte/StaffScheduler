from flask import Flask, render_template
from models import db, User, init_db

app = Flask(__name__)
app.config['SECRET_KEY'] = 'test'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///staffscheduler.db'
init_db(app)

print('Testing template render...')
with app.app_context():
    try:
        html = render_template('settings.html', user=None)
        print(f'Success! Template rendered ({len(html)} bytes)')
    except Exception as e:
        print(f'Error: {type(e).__name__}: {e}')




