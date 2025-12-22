# Staff Scheduler Pro

A professional staff scheduling application built with Flask and Google OR-Tools. Features intelligent constraint-based scheduling with a modern, responsive UI.

## Features

- **Smart Scheduling**: Uses Google OR-Tools CP-SAT solver for optimal schedule generation
- **Multiple Business Scenarios**: Pre-configured templates for coffee shops, retail stores, restaurants, call centers, and warehouses
- **Role-Based Scheduling**: Assign employees to specific roles with coverage requirements
- **Flexible Constraints**:
  - Minimum/maximum shift lengths
  - Maximum hours per day
  - Maximum days per week (per employee type)
  - Split shift limits
  - Supervision requirements
- **Employee Management**: Full CRUD for employees with availability, preferences, and time-off
- **Modern UI**: Dark/light mode, responsive design, grid and table views

## Installation

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/StaffScheduler.git
cd StaffScheduler
```

2. Create a virtual environment (optional but recommended):
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Run the application:
```bash
python app.py
```

5. Open your browser to `http://localhost:5000`

## Requirements

- Python 3.10+
- Flask 3.0+
- Google OR-Tools 9.8+

## Project Structure

```
StaffScheduler/
├── app.py                 # Flask application and API routes
├── requirements.txt       # Python dependencies
├── scheduler/
│   ├── __init__.py
│   ├── businesses.py      # Business scenario definitions
│   ├── models.py          # Data models
│   ├── sample_data.py     # Sample data helpers
│   └── solver.py          # OR-Tools constraint solver
├── static/
│   ├── app.js            # Frontend JavaScript
│   └── style.css         # Styles
└── templates/
    └── index.html        # Main HTML template
```

## Usage

1. **Generate Schedule**: Click "Generate Schedule" to create an optimal schedule
2. **Find Alternative**: Get different schedule variations
3. **Manage Staff**: Add, edit, or remove employees in the Staff tab
4. **Set Availability**: Configure when each employee can work
5. **Configure Requirements**: Set shift requirements, roles, and advanced rules

## License

MIT License
