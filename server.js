const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

// ─── Email Configuration ──────────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT || '';

let transporter = null;

function initializeMailer() {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.warn('⚠️  Email credentials not configured. Email notifications disabled.');
        return null;
    }
    
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: GMAIL_USER,
            pass: GMAIL_APP_PASSWORD
        }
    });
    
    console.log('✅ Email service initialized');
    return transporter;
}

async function sendScanResultEmail(scanResult) {
    if (!transporter || !EMAIL_RECIPIENT) {
        console.log('⚠️  Email not sent: Missing configuration');
        return;
    }

    try {
        const csvContent = generateCSV(scanResult);
        const filename = `nse_scan_${scanResult.scanTimestamp.replace(/[: ]/g, '_')}.csv`;
        
        const mailOptions = {
            from: GMAIL_USER,
            to: EMAIL_RECIPIENT,
            subject: `NSE Scanner Results - ${scanResult.scanTimestamp}`,
            html: `
                <h2>NSE Options Scanner Results</h2>
                <p><strong>Scan Time:</strong> ${scanResult.scanTimestamp}</p>
                <p><strong>Expiry:</strong> ${scanResult.expiry}</p>
                <p><strong>Total Symbols Scanned:</strong> ${scanResult.totalScannedSuccessfully}</p>
                <p><strong>Stocks Meeting Conditions:</strong> ${scanResult.stocksMeetingConditions}</p>
                <p><strong>Scan Duration:</strong> ${scanResult.scanTime}s</p>
                <hr>
                <p>CSV file with detailed results is attached.</p>
            `,
            attachments: [
                {
                    filename: filename,
                    content: csvContent,
                    contentType: 'text/csv'
                }
            ]
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent successfully: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
        return false;
    }
}

// ─── Storage Setup ────────────────────────────────────────────────────────────
const RESULTS_FILE = path.join(__dirname, 'scan_results.json');

function loadResults() {
    try {
        if (fs.existsSync(RESULTS_FILE)) {
            return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading results:', e.message);
    }
    return [];
}

function saveResults(results) {
    try {
        fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    } catch (e) {
        console.error('Error saving results:', e.message);
    }
}

// Keep only last 30 scan results
function appendResult(newResult) {
    const all = loadResults();
    all.unshift(newResult); // newest first
    if (all.length > 30) all.splice(30);
    saveResults(all);
    return all;
}

// ─── NSE Headers ─────────────────────────────────────────────────────────────
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/option-chain',
    'Origin': 'https://www.nseindia.com',
};

// ─── Semaphore ────────────────────────────────────────────────────────────────
class Semaphore {
    constructor(max) {
        this.max = max;
        this.count = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.count < this.max) { this.count++; return; }
        await new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        this.count--;
        if (this.queue.length > 0) {
            this.count++;
            this.queue.shift()();
        }
    }
}

// ─── NSE Logic ────────────────────────────────────────────────────────────────
async function fetchFnoSymbols(axiosInstance) {
    const url = "https://www.nseindia.com/api/underlying-information?segment=equity";
    const response = await axiosInstance.get(url);
    if (response.status !== 200) throw new Error(`Failed to fetch symbols HTTP ${response.status}`);
    const underlyingList = response.data?.data?.UnderlyingList || [];
    const symbols = underlyingList
        .filter(row => typeof row === 'object' && row !== null && row.symbol)
        .map(row => row.symbol.trim());
    symbols.sort();
    return symbols;
}

function getTargetExpiry() {
    // Returns the nearest monthly expiry date string in "DD-Mon-YYYY" format
    // Update this manually or auto-calculate as needed
    return "24-Feb-2026";
}

function checkFutstkCondition(record, targetExpiry) {
    if (record.instrumentType !== 'FUTSTK' || record.expiryDate !== targetExpiry) return false;
    const openPrice = record.openPrice || 0;
    const prevClose = record.prevClose || 0;
    if (prevClose <= 0) return false;
    const pct = ((openPrice - prevClose) / prevClose) * 100;
    return pct >= -0.5 && pct <= 0.5;
}

async function getCountsForSymbol(axiosInstance, symbol, semaphore) {
    const url = `https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolDerivativesData&symbol=${symbol}`;
    await semaphore.acquire();
    try {
        const response = await axiosInstance.get(url, { timeout: 10000 });
        if (response.status !== 200) return [symbol, 0, 0, 0, 0, `HTTP ${response.status}`];

        const records = response.data?.data || [];
        const targetExpiry = getTargetExpiry();

        const futstkOk = records.some(r => checkFutstkCondition(r, targetExpiry));
        if (!futstkOk) return [symbol, 0, 0, 0, 0, "FUTSTK condition not met"];

        let callOpenLow = 0, callOpenHigh = 0, putOpenLow = 0, putOpenHigh = 0;

        for (const record of records) {
            if (record.expiryDate !== targetExpiry) continue;
            if (record.instrumentType !== 'OPTSTK') continue;
            const openPrice = record.openPrice || 0;
            if (openPrice <= 0) continue;
            if ((record.totalTradedVolume || 0) <= 0) continue;
            const optionType = (record.optionType || '').toUpperCase();
            if (optionType === 'CE') {
                if (openPrice === record.lowPrice) callOpenLow++;
                if (openPrice === record.highPrice) callOpenHigh++;
            } else if (optionType === 'PE') {
                if (openPrice === record.lowPrice) putOpenLow++;
                if (openPrice === record.highPrice) putOpenHigh++;
            }
        }
        return [symbol, callOpenLow, callOpenHigh, putOpenLow, putOpenHigh, "Success"];
    } catch (error) {
        return [symbol, 0, 0, 0, 0, error.code === 'ECONNABORTED' ? "Timeout" : `Error: ${error.message}`];
    } finally {
        semaphore.release();
    }
}

// ─── Core Scan Function ───────────────────────────────────────────────────────
async function runScan() {
    console.log(`\n🔍 Scan started at ${new Date().toISOString()}`);
    const startTime = Date.now();

    const axiosInstance = axios.create({ headers, timeout: 15000 });

    // Warm up cookie
    try { await axiosInstance.get("https://www.nseindia.com", { timeout: 5000 }); } catch (_) {}

    const symbols = await fetchFnoSymbols(axiosInstance);
    const semaphore = new Semaphore(10);
    const tasks = symbols.map(symbol => getCountsForSymbol(axiosInstance, symbol, semaphore));
    const results = await Promise.all(tasks);

    let totalScannedSuccessfully = 0;
    let stocksMeetingConditions = 0;
    const group1 = [];
    const group2 = [];

    for (const [symbol, callOpenLow, callOpenHigh, putOpenLow, putOpenHigh, status] of results) {
        if (status.includes("HTTP") || status.includes("Timeout") || status.includes("Error")) continue;
        totalScannedSuccessfully++;
        if (status === "Success") {
            stocksMeetingConditions++;
            group1.push({ symbol, ceOL: callOpenLow, peOH: putOpenHigh });
            group2.push({ symbol, peOL: putOpenLow, ceOH: callOpenHigh });
        }
    }

    group1.sort((a, b) => b.ceOL - a.ceOL);
    group2.sort((a, b) => b.peOL - a.peOL);

    const scanTime = ((Date.now() - startTime) / 1000).toFixed(2);

    // Convert to IST for display
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    const scanTimestamp = istDate.toISOString().replace('T', ' ').substring(0, 19) + ' IST';

    const scanResult = {
        id: Date.now(),
        scanTimestamp,
        totalSymbols: symbols.length,
        totalScannedSuccessfully,
        stocksMeetingConditions,
        scanTime,
        expiry: getTargetExpiry(),
        bullish: group1.slice(0, 10),
        bearish: group2.slice(0, 10),
    };

    appendResult(scanResult);
    console.log(`✅ Scan complete: ${stocksMeetingConditions} stocks qualified in ${scanTime}s`);
    
    // Send email notification with CSV
    await sendScanResultEmail(scanResult);
    
    return scanResult;
}

// ─── Scheduler (IST Times) ────────────────────────────────────────────────────
// Scheduled scan times in IST: 9:20, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 15:25
const SCAN_TIMES_IST = [
    { h: 9,  m: 20 },
    { h: 10, m: 0  },
    { h: 11, m: 0  },
    { h: 12, m: 0  },
    { h: 13, m: 0  },
    { h: 14, m: 0  },
    { h: 15, m: 0  },
    { h: 15, m: 25 },
];

function getISTHoursMinutes() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);
    return { h: ist.getUTCHours(), m: ist.getUTCMinutes(), day: ist.getUTCDay() };
}

function scheduleNextScan() {
    const checkInterval = setInterval(() => {
        const { h, m, day } = getISTHoursMinutes();

        // Only run on weekdays (Mon-Fri = 1-5)
        if (day < 1 || day > 5) return;

        const match = SCAN_TIMES_IST.find(t => t.h === h && t.m === m);
        if (match) {
            console.log(`⏰ Scheduled scan triggered at ${h}:${String(m).padStart(2,'0')} IST`);
            runScan().catch(err => console.error('Scheduled scan error:', err));
        }
    }, 60 * 1000); // Check every minute

    console.log('📅 Scheduler active. Scans at: 9:20, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 15:25 IST (Mon-Fri)');
    return checkInterval;
}

// ─── CSV Generator ────────────────────────────────────────────────────────────
function generateCSV(scanResult) {
    const lines = [];
    lines.push(`NSE Options Scanner - ${scanResult.scanTimestamp}`);
    lines.push(`Expiry: ${scanResult.expiry}`);
    lines.push(`Total Symbols: ${scanResult.totalSymbols} | Scanned: ${scanResult.totalScannedSuccessfully} | Qualified: ${scanResult.stocksMeetingConditions} | Time: ${scanResult.scanTime}s`);
    lines.push('');

    lines.push('BULLISH TOP 10');
    lines.push('Rank,Symbol,CE_OL,PE_OH');
    scanResult.bullish.forEach((s, i) => {
        lines.push(`${i + 1},${s.symbol},${s.ceOL},${s.peOH}`);
    });

    lines.push('');
    lines.push('BEARISH TOP 10');
    lines.push('Rank,Symbol,PE_OL,CE_OH');
    scanResult.bearish.forEach((s, i) => {
        lines.push(`${i + 1},${s.symbol},${s.peOL},${s.ceOH}`);
    });

    return lines.join('\n');
}

function generateAllCSV(allResults) {
    const lines = [];
    lines.push('Timestamp,Expiry,Type,Rank,Symbol,Col1,Col2');
    for (const result of allResults) {
        result.bullish.forEach((s, i) => {
            lines.push(`${result.scanTimestamp},${result.expiry},BULLISH,${i+1},${s.symbol},${s.ceOL},${s.peOH}`);
        });
        result.bearish.forEach((s, i) => {
            lines.push(`${result.scanTimestamp},${result.expiry},BEARISH,${i+1},${s.symbol},${s.peOL},${s.ceOH}`);
        });
    }
    return lines.join('\n');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Manual scan trigger
app.get('/api/scan', async (req, res) => {
    try {
        const result = await runScan();
        res.json(result);
    } catch (error) {
        console.error('Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all saved results
app.get('/api/results', (req, res) => {
    try {
        const results = loadResults();
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get latest result
app.get('/api/results/latest', (req, res) => {
    try {
        const results = loadResults();
        if (results.length === 0) return res.json(null);
        res.json(results[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download single scan as CSV
app.get('/api/download/csv/:id', (req, res) => {
    try {
        const results = loadResults();
        const result = results.find(r => String(r.id) === String(req.params.id));
        if (!result) return res.status(404).json({ error: 'Scan not found' });
        const csv = generateCSV(result);
        const filename = `nse_scan_${result.scanTimestamp.replace(/[: ]/g, '_')}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download all scans as CSV
app.get('/api/download/csv/all', (req, res) => {
    try {
        const results = loadResults();
        if (results.length === 0) return res.status(404).json({ error: 'No results yet' });
        const csv = generateAllCSV(results);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="nse_all_scans.csv"');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    initializeMailer();
    scheduleNextScan();
});
