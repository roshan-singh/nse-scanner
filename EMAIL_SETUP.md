# Email Setup Guide for NSE Scanners

## Overview
The scanners now automatically email CSV results after each scan. Results are sent via email, so they're permanently saved even when the server restarts.

---

## Quick Setup (Gmail)

### Step 1: Generate Gmail App Password

1. **Go to Google Account:** https://myaccount.google.com/
2. **Security** → **2-Step Verification** (enable if not already)
3. **App passwords** → Create new
4. **Select app:** Mail
5. **Select device:** Other (Custom name) → Type "NSE Scanner"
6. **Generate** → Copy the 16-character password (e.g., `abcd efgh ijkl mnop`)

### Step 2: Set Environment Variables in Render

1. **Open Render Dashboard:** https://dashboard.render.com
2. **Select your service:** nse-scanner
3. **Environment** tab → **Add Environment Variable**
4. **Add these variables:**

```
EMAIL_ENABLED=true
EMAIL_SERVICE=gmail
EMAIL_USER=your.email@gmail.com
EMAIL_PASS=abcd efgh ijkl mnop
EMAIL_TO=your.email@gmail.com
```

**Replace:**
- `your.email@gmail.com` → Your Gmail address
- `abcd efgh ijkl mnop` → The 16-character app password you generated

### Step 3: Save & Deploy

1. Click **Save Changes**
2. Render will auto-redeploy (takes ~60 seconds)
3. Check logs for: `📧 Email notifications enabled`

---

## What You'll Receive

### FnO Options Scanner Email
**Subject:** 📊 FnO Scan Results - 2026-02-13 09:17:00 IST

**Content:**
```
FnO Options Scanner Results

Scan Time: 2026-02-13 09:17:00 IST
Expiry: 27-Feb-2026
Total Symbols: 189
Scanned Successfully: 175
Qualified Stocks: 42
Scan Duration: 87.5s

Top Bullish: RELIANCE, TCS, INFY
Top Bearish: SBIN, ICICIBANK, HDFCBANK

Full results attached as CSV.
```

**Attachment:** `fno_scan_2026-02-13_09_17_00_IST.csv`

### Top Losers OH Email
**Subject:** 📉 Losers OH Scan Results - 2026-02-13 09:31:00 IST

**Content:**
```
Top Losers OH Scanner Results

Scan Time: 2026-02-13 09:31:00 IST
Total FOSec Stocks: 156
EQ Stocks with Open=High: 8
Scan Duration: 3.2s

Top 5 Stocks:
TATAMOTORS (LTP: 945.50, Change: -2.35%)
MARUTI (LTP: 12340.20, Change: -1.85%)
...

Full results attached as CSV.
```

**Attachment:** `losers_oh_2026-02-13_09_31_00_IST.csv`

---

## Email Schedule

### Monday - Friday
- **09:17 IST** → FnO Scan email
- **09:18 IST** → FnO Scan email
- **09:19 IST** → FnO Scan email
- **09:20 IST** → FnO Scan email
- **09:21 IST** → FnO Scan email
- **09:31 IST** → Losers OH Scan email

**Total:** 6 emails per trading day

---

## Alternative Email Services

### Outlook/Hotmail

```
EMAIL_SERVICE=outlook
EMAIL_USER=your.email@outlook.com
EMAIL_PASS=your_password
```

### Yahoo Mail

```
EMAIL_SERVICE=yahoo
EMAIL_USER=your.email@yahoo.com
EMAIL_PASS=your_app_password
```

### Custom SMTP

For other providers, you can manually configure SMTP in server.js.

---

## Troubleshooting

### No emails received?

1. **Check Render logs:**
   - Look for `📧 Email notifications enabled`
   - Look for `✅ Email sent: ...`
   - If you see `❌ Email send failed`, check the error

2. **Check spam/junk folder**

3. **Verify environment variables:**
   - Go to Render → Environment tab
   - Make sure all 5 variables are set
   - `EMAIL_ENABLED` must be exactly `true` (lowercase)

4. **Test Gmail app password:**
   - Delete old app password in Google Account
   - Generate a new one
   - Update `EMAIL_PASS` in Render

5. **Check Gmail security:**
   - Make sure 2-Step Verification is ON
   - Make sure "Less secure app access" is OFF (use app passwords instead)

### Emails going to spam?

Add your sender email to contacts or whitelist.

### Want to send to multiple emails?

Change `EMAIL_TO` to comma-separated:
```
EMAIL_TO=email1@gmail.com,email2@gmail.com,email3@gmail.com
```

---

## Disable Email Notifications

Set in Render environment variables:
```
EMAIL_ENABLED=false
```

Or remove all EMAIL_* variables.

---

## Cost

**Gmail:** Free (up to 500 emails/day)
**Outlook:** Free (up to 300 emails/day)

With 6 emails/day (Mon-Fri), you'll use ~26 emails/month - well within free limits.

---

## Security Notes

- **Never commit** your email password to GitHub
- **Use app passwords**, not your actual Gmail password
- **App passwords** can be revoked anytime in Google Account settings
- Render environment variables are encrypted and secure

---

## Questions?

- **Gmail App Passwords:** https://support.google.com/accounts/answer/185833
- **Render Environment Variables:** https://docs.render.com/environment-variables
