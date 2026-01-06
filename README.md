# Staff Scheduler Pro

A professional staff scheduling application for managing employee shifts, availability, and coverage requirements.

**Live Site:** [https://thestaffscheduler.com](https://thestaffscheduler.com)

## Features

### Core Scheduling
- **Smart Scheduling**: Intelligent constraint-based schedule generation using OR-Tools CP-SAT optimization
- **Multiple Business Types**: Support for coffee shops, retail stores, restaurants, call centers, warehouses, and custom businesses
- **Timeline View**: Visual drag-and-drop schedule editing with shift resizing
- **Role-Based Scheduling**: Assign employees to specific roles with configurable coverage requirements
- **Flexible Constraints**:
  - Minimum/maximum shift lengths
  - Maximum hours per day
  - Maximum days per week (configurable by employee type)
  - Split shift limits
  - Supervision requirements
- **Alternative Schedules**: Generate multiple schedule options that meet all constraints
- **Week Navigation**: Browse and manage schedules across different weeks
- **Publish Workflow**: Draft and publish schedules with status tracking

### Employee Management
- **Full Employee Profiles**: Track roles, certifications, availability preferences, and hourly rates
- **Availability Grid**: Click-and-drag availability selection for each employee
- **Time-Off Requests**: Mark unavailable slots and preferred hours
- **Employee Portal**: Read-only schedule view for non-manager employees
- **Email Invitations**: Send portal access invitations to employees via email

### User & Business Management
- **User Authentication**: Secure login/signup with email and password
- **Multi-Location Support**: Manage multiple business locations from a single account
- **Custom Business Creation**: Create your own business with custom name, roles, and settings
- **Demo Businesses**: Try the app with pre-configured demo scenarios

### Modern UI/UX
- **Dark/Light Mode**: Theme toggle for user preference
- **Responsive Design**: Works on desktop and mobile devices
- **Multiple View Options**: Timeline, grid, and table views
- **Color-Coded Roles**: Visual distinction between different roles and employees

## Technology Stack

### Backend
- **Python 3.11** - Core programming language
- **Flask 3.0** - Web framework
- **SQLAlchemy** - ORM for database operations
- **Flask-Login** - User session management
- **Flask-Bcrypt** - Password hashing

### Database
- **PostgreSQL** - Production database (Railway)
- **SQLite** - Local development fallback

### Scheduling Engine
- **Google OR-Tools** - CP-SAT constraint programming solver for schedule optimization

### Email Service
- **Resend API** - Transactional email delivery for employee invitations
- Fallback: SMTP (Gmail) for local development

### Frontend
- **HTML5 / CSS3** - Semantic markup and modern styling
- **Vanilla JavaScript** - No framework dependencies, fast load times
- **CSS Variables** - Consistent theming and dark mode support

### Production Infrastructure
- **Gunicorn** - WSGI HTTP server (multi-worker)
- **Railway** - Platform-as-a-Service hosting
- **Cloudflare** - DNS, CDN, and SSL

## Architecture

### How Scheduling Works

1. **Input Collection**: The system collects:
   - Employee availability windows (when each person can work)
   - Role coverage requirements (how many of each role needed per hour)
   - Business rules (max hours, shift lengths, supervision needs)

2. **Constraint Modeling**: OR-Tools builds a constraint satisfaction problem:
   - Each employee-hour is a boolean variable (working or not)
   - Constraints encode all business rules
   - Objective function balances coverage vs. labor costs

3. **Optimization**: The CP-SAT solver finds optimal schedules:
   - Guarantees constraint satisfaction
   - Minimizes coverage gaps
   - Balances workload across employees
   - Typical solve time: <60 seconds for 50+ employees

4. **Alternative Generation**: Request multiple solutions by adding diversity constraints

### URL Routing

The app uses slug-based URLs for bookmarkable navigation:
- `/sunrise-coffee/schedule` - Schedule view
- `/sunrise-coffee/staff` - Staff management  
- `/sunrise-coffee/availability` - Availability editor
- `/sunrise-coffee/requirements` - Shift requirements
- `/sunrise-coffee/settings` - Business settings

### Employee Portal Routes
- `/employee/{business-slug}/{employee-id}/schedule` - Employee's schedule view
- `/employee/{business-slug}/{employee-id}/availability` - Employee availability editor

### Data Persistence

**Database Models:**
- `User` - Authentication and user profiles
- `DBBusiness` - Business configurations and metadata
- `DBEmployee` - Employee records with availability data
- `DBRole` - Role definitions per business
- `DBSchedule` - Published schedules with assignments
- `DBShiftTemplate` - Reusable shift patterns

**Multi-Worker Handling:**
- Production runs multiple Gunicorn workers for scalability
- Each worker has its own memory space
- Database is the source of truth for all persistent data
- Force-reload from DB on employee portal access to ensure freshness

### Email Integration

**Resend API (Production):**
- HTTP-based email delivery (works on platforms that block SMTP)
- Verified custom domain: `noreply@thestaffscheduler.com`
- HTML email templates with branding

**Invitation Flow:**
1. Manager adds employee with email address
2. Checks "Send portal invitation" option
3. System generates unique portal URL
4. Email sent via Resend API with portal link
5. Employee clicks link to view their schedule

## Deployment

### Railway Configuration

**Procfile:**
```
web: gunicorn app:app --bind 0.0.0.0:$PORT
```

**runtime.txt:**
```
python-3.11.6
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Port to bind (provided by Railway) | Auto |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SECRET_KEY` | Flask session encryption key | Yes |
| `SITE_URL` | Production URL for email links | Yes |
| `RESEND_API_KEY` | Resend API key for emails | Yes |
| `RESEND_FROM_EMAIL` | Verified sender email | Yes |
| `MAIL_USERNAME` | SMTP username (fallback) | No |
| `MAIL_PASSWORD` | SMTP password (fallback) | No |

### Domain Configuration

- **Primary Domain**: `thestaffscheduler.com`
- **DNS Provider**: Cloudflare (CNAME flattening for apex domain)
- **SSL**: Automatic via Cloudflare/Railway
- **WWW Redirect**: Cloudflare rule redirects `www` → apex

## Local Development

### Setup

```bash
# Clone the repository
git clone https://github.com/otterholte/StaffScheduler.git
cd StaffScheduler

# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install dependencies
pip install -r requirements.txt

# Create .env file with local settings
echo "FLASK_DEBUG=true" > .env
echo "SECRET_KEY=dev-secret-key" >> .env

# Run the application
python app.py
```

### Testing Email Locally

For local email testing, set SMTP credentials in `.env`:
```
MAIL_USERNAME=your-gmail@gmail.com
MAIL_PASSWORD=your-app-password
MAIL_SERVER=smtp.gmail.com
MAIL_PORT=587
```

## Project Structure

```
StaffScheduler/
├── app.py              # Main Flask application
├── auth.py             # Authentication routes
├── config.py           # Configuration classes
├── db_service.py       # Database operations
├── email_service.py    # Email sending logic
├── models.py           # SQLAlchemy models
├── scheduler/
│   ├── __init__.py
│   ├── models.py       # Dataclass models
│   ├── solver.py       # OR-Tools scheduling engine
│   ├── businesses.py   # Business scenario management
│   └── sample_data.py  # Demo data
├── static/
│   ├── app.js          # Main JavaScript
│   ├── style.css       # Main styles
│   ├── employee.css    # Employee portal styles
│   └── employee.js     # Employee portal JS
├── templates/
│   ├── index.html      # Main manager dashboard
│   ├── landing.html    # Marketing homepage
│   ├── login.html      # Authentication pages
│   ├── employee_schedule.html
│   └── employee_availability.html
├── Procfile            # Railway process definition
├── requirements.txt    # Python dependencies
└── runtime.txt         # Python version
```

## License

**Copyright (c) 2026 Staff Scheduler Pro. All Rights Reserved.**

This is proprietary software. Unauthorized copying, modification, distribution, or use of this software is strictly prohibited. See the [LICENSE](LICENSE) file for details.
