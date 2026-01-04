# Staff Scheduler Pro

A professional staff scheduling application for managing employee shifts, availability, and coverage requirements.

**Live Site:** [https://thestaffscheduler.com](https://thestaffscheduler.com)

## Features

- **Smart Scheduling**: Intelligent constraint-based schedule generation using optimization algorithms
- **Multiple Business Types**: Support for coffee shops, retail stores, restaurants, call centers, warehouses, and custom businesses
- **Timeline View**: Visual drag-and-drop schedule editing with shift resizing
- **Role-Based Scheduling**: Assign employees to specific roles with configurable coverage requirements
- **Flexible Constraints**:
  - Minimum/maximum shift lengths
  - Maximum hours per day
  - Maximum days per week (configurable by employee type)
  - Split shift limits
  - Supervision requirements
- **Employee Management**: Full employee profiles with availability, preferences, and time-off tracking
- **Availability Grid**: Click-and-drag availability selection for each employee
- **Shift Templates**: Define reusable shift patterns for easy requirement setup
- **Modern UI**: Dark/light mode, responsive design, multiple view options (timeline, grid, table)
- **Week Navigation**: Browse and manage schedules across different weeks
- **Publish Workflow**: Draft and publish schedules with status tracking

## Technology Stack

- **Backend**: Python 3.11, Flask 3.0
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Scheduling Engine**: Google OR-Tools CP-SAT Solver
- **Production Server**: Gunicorn WSGI
- **Hosting**: Railway (PaaS)
- **DNS & CDN**: Cloudflare

## Architecture

### How It Works

1. **Schedule Generation**: The app uses Google OR-Tools constraint programming solver to generate optimal schedules based on:
   - Employee availability windows
   - Role coverage requirements
   - Business operating hours
   - Configurable constraints (max hours, shift lengths, etc.)

2. **URL Routing**: The app uses slug-based URLs (`/location-name/page`) for bookmarkable navigation:
   - `/sunrise-coffee/schedule` - Schedule view for Sunrise Coffee
   - `/sunrise-coffee/staff` - Staff management
   - `/sunrise-coffee/availability` - Availability editor
   - `/sunrise-coffee/requirements` - Shift requirements

3. **Data Persistence**: 
   - Schedule data is cached in-memory on the server
   - Client-side localStorage for schedule drafts and preferences
   - Business configurations are maintained in Python modules

## Deployment

The application is deployed on **Railway** with **Cloudflare** managing DNS and SSL.

### Production Configuration

- **Procfile**: Defines the web process using Gunicorn
  ```
  web: gunicorn app:app --bind 0.0.0.0:$PORT
  ```

- **runtime.txt**: Specifies Python version
  ```
  python-3.11.6
  ```

- **requirements.txt**: Python dependencies
  ```
  Flask==3.0.0
  gunicorn==21.2.0
  ortools==9.8.3296
  ```

### Domain Configuration

- **Primary Domain**: `thestaffscheduler.com`
- **DNS Provider**: Cloudflare (CNAME flattening for apex domain)
- **SSL**: Automatic via Cloudflare/Railway
- **WWW Redirect**: Cloudflare redirect rule sends `www.thestaffscheduler.com` → `thestaffscheduler.com`

### Environment Variables

The app reads the following environment variables in production:
- `PORT` - Port to bind (provided by Railway)
- `FLASK_DEBUG` - Set to `true` for debug mode (omit in production)

## License

**Copyright (c) 2026 Staff Scheduler Pro. All Rights Reserved.**

This is proprietary software. Unauthorized copying, modification, distribution, or use of this software is strictly prohibited. See the [LICENSE](LICENSE) file for details.
