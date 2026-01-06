# Staff Scheduler - Start with Email Configuration
# Run this script to start the server with email enabled

param(
    [string]$Email,
    [string]$AppPassword
)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Staff Scheduler - Email Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if parameters provided
if (-not $Email) {
    $Email = Read-Host "Enter your Gmail address"
}

if (-not $AppPassword) {
    $AppPassword = Read-Host "Enter your Gmail App Password (16 characters)"
}

# Set environment variables
$env:MAIL_USERNAME = $Email
$env:MAIL_PASSWORD = $AppPassword

Write-Host ""
Write-Host "Email configured for: $Email" -ForegroundColor Green
Write-Host ""

# Test email configuration
Write-Host "Testing email configuration..." -ForegroundColor Yellow
python test_email.py

Write-Host ""
$sendTest = Read-Host "Send a test email to yourself? (y/n)"

if ($sendTest -eq "y" -or $sendTest -eq "Y") {
    python test_email.py $Email
}

Write-Host ""
Write-Host "Starting server..." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

python app.py

