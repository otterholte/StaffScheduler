# Gunicorn configuration file
import os

# Bind to the port provided by Railway
bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"

# Worker timeout - must be long enough for OR-Tools schedule generation
# OR-Tools can take 60+ seconds for complex schedules
timeout = 180

# Graceful timeout for worker shutdown
graceful_timeout = 180

# Number of workers
workers = 2

# Worker class
worker_class = "sync"

# Logging
accesslog = "-"
errorlog = "-"
loglevel = "info"


