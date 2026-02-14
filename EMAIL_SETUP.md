# Email Notification Setup Guide

## Overview
The NSE Scanner now automatically sends email notifications with CSV attachments whenever a scan completes.

## Prerequisites
- Gmail account
- Gmail App Password (not your regular password)

## Step-by-Step Setup

### 1. Enable 2-Factor Authentication on Gmail
- Go to https://myaccount.google.com/
- Click "Security" in the left sidebar
- Enable "2-Step Verification" if not already enabled

### 2. Generate Gmail App Password
- Go to https://myaccount.google.com/apppasswords
- Select "Mail" and "Windows Computer" (or your device)
- Click "Generate"
- Copy the 16-character password provided
- This is your `GMAIL_APP_PASSWORD`

### 3. Configure Environment Variables

#### For Render Deployment:
1. Go to your Render dashboard
2. Select your NSE Scanner service
3. Click "Environment" on the left sidebar
4. Add the following environment variables:

```
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-char-app-password
EMAIL_RECIPIENT=recipient@gmail.com
```

**Example:**
```
GMAIL_USER=trading@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
EMAIL_RECIPIENT=alerts@yourmail.com
```

#### For Local Development:
Create a `.env` file in the project root:
```
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-app-password-here
EMAIL_RECIPIENT=recipient@gmail.com
PORT=3000
```

Then install dotenv:
```bash
npm install dotenv
```

Add to the top of server.js:
```javascript
require('dotenv').config();
```

### 4. Reinstall Dependencies
After updating package.json, run:
```bash
npm install
```

### 5. Test Email Functionality
- Trigger a manual scan via the UI or:
```bash
curl http://localhost:3000/api/scan
```
- Check your email for the results

## Email Features
✅ Automatic CSV attachment with scan results
✅ Formatted HTML email with key metrics
✅ Filename includes scan timestamp
✅ Sent immediately after each scan completes
✅ Works with both scheduled and manual scans

## Troubleshooting

### "Email not sent: Missing configuration"
- Verify all three environment variables are set correctly
- Check spelling: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `EMAIL_RECIPIENT`

### "Invalid login - Authentication failed"
- App Password should be 16 characters without spaces when using
- Some systems strip spaces, so try without them if issues occur
- Verify 2-Factor Authentication is enabled

### "Relay access denied"
- Ensure GMAIL_USER matches the account that generated the App Password
- Check that the App Password was created with Mail access

### Emails not received
- Check spam/trash folder
- Add your GMAIL_USER to recipient's contacts to improve delivery
- Verify EMAIL_RECIPIENT email address is correct

## Important Notes
- **Never commit .env file to GitHub** - Add .env to .gitignore
- App Passwords are specific to Gmail and cannot be reused elsewhere
- App Passwords work only with 2-Factor Authentication enabled
- Each scan result is sent immediately upon completion
- CSV filenames are automatically timestamped

## Monitoring
Logs will show:
```
✅ Email service initialized
📧 Email sent successfully: <message-id>
```

Or if disabled:
```
⚠️ Email credentials not configured. Email notifications disabled.
```
