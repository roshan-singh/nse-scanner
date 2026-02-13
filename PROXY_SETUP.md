# Fixing NSE API Blocking (403 Error)

## Problem
NSE India blocks requests from cloud hosting providers like Render, AWS, etc. You'll see:
```
Access Denied - You don't have permission to access
Status: 403
```

This affects the **Top Losers OH scanner** only. The FnO scanner works because it uses different NSE endpoints.

---

## Solutions (Choose One)

### ✅ Solution 1: Free Proxy Services (Easiest)

Use free rotating proxy services:

#### Option A: ScraperAPI (Free Tier)
1. Sign up at https://www.scraperapi.com (1000 free requests/month)
2. Get your API key
3. In Render → Environment variables:
   ```
   PROXY_URL=http://scraperapi:YOUR_API_KEY@proxy-server.scraperapi.com:8001
   ```

#### Option B: WebShare (Free Tier)
1. Sign up at https://www.webshare.io (10 free proxies)
2. Get proxy details
3. In Render → Environment variables:
   ```
   PROXY_URL=http://username:password@proxy.webshare.io:80
   ```

---

### ✅ Solution 2: Disable Losers OH Scanner

If you don't need the Losers OH scanner, you can disable it:

**In server.js**, comment out the Losers scanner schedule:

```javascript
// Check Losers OH scanner time (DISABLED)
// if (LOSERS_SCAN_TIME_IST.h === h && LOSERS_SCAN_TIME_IST.m === m) {
//     console.log(`⏰ Losers OH Scanner triggered at ${h}:${String(m).padStart(2,'0')} IST`);
//     runLosersOHScan().catch(err => console.error('Losers scan error:', err));
// }
```

The FnO scanner will continue working normally.

---

### ✅ Solution 3: Use VPN/Residential Proxy (Paid)

More reliable but costs money:

#### Bright Data (Most reliable)
- Sign up: https://brightdata.com
- Get residential proxy
- ~$500/month for unlimited requests

#### SmartProxy
- Sign up: https://smartproxy.com
- Residential proxies from $12.5/month
- 8GB traffic

---

### ✅ Solution 4: Run Locally + Webhook

Run the Losers scanner on your home PC/tablet (which NSE doesn't block), then send results to Render:

**On your tablet (Termux):**
```bash
# Run locally at 09:31
node losers-scanner-local.js
```

**Script sends results to Render via API**

---

## Why This Happens

| Source | FnO Scanner | Losers Scanner |
|--------|-------------|----------------|
| Home IP | ✅ Works | ✅ Works |
| Cloud Server (Render/AWS) | ✅ Works | ❌ Blocked |

**Reason:** NSE uses different protection levels:
- FnO endpoints: Basic rate limiting
- Live variations endpoint: Strict datacenter IP blocking

---

## Recommended Approach

**For now:**
1. **Keep FnO scanner running** on Render (it works fine)
2. **Disable Losers scanner** on Render
3. **Run Losers scanner locally** on your tablet at 09:31

**Steps to run locally:**

### On Your Tablet (Termux)

1. **Keep the project:**
```bash
cd ~/nse-scanner
```

2. **Create a separate Losers-only script:**
```bash
nano losers-only.js
```

Paste:
```javascript
const axios = require('axios');

async function scanLosers() {
    const axiosInstance = axios.create({ withCredentials: true });
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/'
    };
    
    try {
        // Warm up
        await axiosInstance.get('https://www.nseindia.com', { headers });
        await new Promise(r => setTimeout(r, 1000));
        
        // Fetch data
        const url = "https://www.nseindia.com/api/live-analysis-variations?index=loosers";
        const response = await axiosInstance.get(url, { headers });
        const data = response.data;
        
        const fosecStocks = data['FOSec']['data'] || [];
        const filtered = fosecStocks.filter(s => 
            s['series'] === 'EQ' && s['open_price'] === s['high_price']
        );
        
        console.log(`Found ${filtered.length} stocks with Open=High`);
        console.log(filtered.map(s => s.symbol).join(', '));
        
        // Optionally: Send to email or save to file
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

scanLosers();
```

3. **Schedule it with Termux cron:**
```bash
# Install cronie
pkg install cronie

# Edit crontab
crontab -e

# Add this line (runs at 09:31 IST, Mon-Fri):
# 31 9 * * 1-5 cd ~/nse-scanner && node losers-only.js
```

---

## Testing Solutions

### Test if proxy works:
```bash
# In Render logs, you should see:
📧 Email notifications enabled
🔍 Top Losers OH Scan started...
Using proxy for Losers scan
✅ Losers OH Scan complete: X stocks found
```

### Test local script:
```bash
# In Termux:
cd ~/nse-scanner
node losers-only.js

# Should show results without 403 error
```

---

## Summary

**Best Setup:**
- ✅ **FnO Scanner** → Run on Render (auto-emails results)
- ✅ **Losers Scanner** → Run locally on tablet (NSE doesn't block home IPs)

**Alternative:**
- Pay for proxy service (~$10-50/month) to run both on Render

**Quick Fix:**
- Just disable Losers scanner and keep FnO scanner running

---

## Need Help?

The 403 error is common with NSE. Most traders run scanners from home computers/VPS with residential IPs rather than cloud hosting for this exact reason.
