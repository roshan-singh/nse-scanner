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
// Set these as environment variables in Render dashboard
const EMAIL_CONFIG = {
    enabled: process.env.EMAIL_ENABLED === 'true',
    service: process.env.EMAIL_SERVICE || 'gmail', // gmail, outlook, etc.
    user: process.env.EMAIL_USER, // your email
    pass: process.env.EMAIL_PASS, // app password
    to: process.env.EMAIL_TO || process.env.EMAIL_USER, // recipient email
};

let transporter = null;

if (EMAIL_CONFIG.enabled && EMAIL_CONFIG.user && EMAIL_CONFIG.pass) {
    transporter = nodemailer.createTransport({
        service: EMAIL_CONFIG.service,
        auth: {
            user: EMAIL_CONFIG.user,
            pass: EMAIL_CONFIG.pass,
        },
    });
    console.log('📧 Email notifications enabled');
} else {
    console.log('📧 Email notifications disabled (set environment variables to enable)');
}

async function sendEmail(subject, text, csvAttachment) {
    if (!transporter || !EMAIL_CONFIG.enabled) return;
    
    try {
        const mailOptions = {
            from: EMAIL_CONFIG.user,
            to: EMAIL_CONFIG.to,
            subject: subject,
            text: text,
            attachments: csvAttachment ? [{
                filename: csvAttachment.filename,
                content: csvAttachment.content,
            }] : [],
        };
        
        await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent: ${subject}`);
    } catch (error) {
        console.error('❌ Email send failed:', error.message);
    }
}

// ─── Storage Setup ────────────────────────────────────────────────────────────
const FNO_RESULTS_FILE = path.join(__dirname, 'fno_scan_results.json');
const LOSERS_RESULTS_FILE = path.join(__dirname, 'losers_scan_results.json');

function loadResults(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        }
    } catch (e) {
        console.error(`Error loading results from ${filepath}:`, e.message);
    }
    return [];
}

function saveResults(filepath, results) {
    try {
        fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    } catch (e) {
        console.error(`Error saving results to ${filepath}:`, e.message);
    }
}

function appendResult(filepath, newResult) {
    const all = loadResults(filepath);
    all.unshift(newResult); // newest first
    if (all.length > 30) all.splice(30);
    saveResults(filepath, all);
    return all;
}

// ─── NSE Headers ─────────────────────────────────────────────────────────────
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/',
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

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNER 1: FnO OPTIONS SCANNER
// ═══════════════════════════════════════════════════════════════════════════════

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
    return "27-Feb-2026"; // Update monthly
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

async function runFnoScan() {
    console.log(`\n🔍 FnO Scan started at ${new Date().toISOString()}`);
    const startTime = Date.now();

    const axiosInstance = axios.create({ headers, timeout: 15000 });
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

    appendResult(FNO_RESULTS_FILE, scanResult);
    console.log(`✅ FnO Scan complete: ${stocksMeetingConditions} stocks qualified in ${scanTime}s`);
    
    // Send email with results
    if (EMAIL_CONFIG.enabled) {
        const csv = generateFnoCSV(scanResult);
        const emailText = `FnO Options Scanner Results\n\n` +
            `Scan Time: ${scanTimestamp}\n` +
            `Expiry: ${scanResult.expiry}\n` +
            `Total Symbols: ${scanResult.totalSymbols}\n` +
            `Scanned Successfully: ${totalScannedSuccessfully}\n` +
            `Qualified Stocks: ${stocksMeetingConditions}\n` +
            `Scan Duration: ${scanTime}s\n\n` +
            `Top Bullish: ${group1.slice(0, 3).map(s => s.symbol).join(', ')}\n` +
            `Top Bearish: ${group2.slice(0, 3).map(s => s.symbol).join(', ')}\n\n` +
            `Full results attached as CSV.`;
        
        await sendEmail(
            `📊 FnO Scan Results - ${scanTimestamp}`,
            emailText,
            {
                filename: `fno_scan_${scanTimestamp.replace(/[: ]/g, '_')}.csv`,
                content: csv
            }
        );
    }
    
    return scanResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNER 2: TOP LOSERS OH (OPEN = HIGH)
// ═══════════════════════════════════════════════════════════════════════════════

async function runLosersOHScan() {
    console.log(`\n🔍 Top Losers OH Scan started at ${new Date().toISOString()}`);
    const startTime = Date.now();

    // Create axios instance with better headers and potential proxy
    const axiosConfig = {
        withCredentials: true,
        headers: {
            ...headers,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.nseindia.com/market-data/live-market-indices',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
        },
        timeout: 15000,
    };

    // Add proxy if configured
    if (process.env.PROXY_URL) {
        const proxyUrl = new URL(process.env.PROXY_URL);
        axiosConfig.proxy = {
            host: proxyUrl.hostname,
            port: proxyUrl.port || 80,
            auth: proxyUrl.username ? {
                username: proxyUrl.username,
                password: proxyUrl.password
            } : undefined
        };
        console.log('Using proxy for Losers scan');
    }

    const axiosInstance = axios.create(axiosConfig);
    
    // Warm up cookie with main page first
    try {
        await axiosInstance.get('https://www.nseindia.com', { timeout: 5000 });
        // Add small delay to mimic human behavior
        await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
        console.log('Cookie warmup failed:', err.message);
    }

    try {
        const url = "https://www.nseindia.com/api/live-analysis-variations?index=loosers";
        const response = await axiosInstance.get(url);
        const data = response.data;

        const fosecStocks = data['FOSec']['data'] || [];
        
        const filteredStocks = fosecStocks
            .filter(stock => stock['series'] === 'EQ' && stock['open_price'] === stock['high_price'])
            .map(stock => ({
                symbol: stock['symbol'],
                open: stock['open_price'],
                high: stock['high_price'],
                low: stock['low_price'],
                ltp: stock['ltp'],
                change: stock['perChange'],
                volume: stock['trade_quantity']
            }));

        const scanTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(now.getTime() + istOffset);
        const scanTimestamp = istDate.toISOString().replace('T', ' ').substring(0, 19) + ' IST';

        const scanResult = {
            id: Date.now(),
            scanTimestamp,
            totalFOSecStocks: fosecStocks.length,
            qualifiedStocks: filteredStocks.length,
            scanTime,
            stocks: filteredStocks
        };

        appendResult(LOSERS_RESULTS_FILE, scanResult);
        console.log(`✅ Losers OH Scan complete: ${filteredStocks.length} stocks found in ${scanTime}s`);
        
        // Send email with results
        if (EMAIL_CONFIG.enabled) {
            const csv = generateLosersCSV(scanResult);
            const topStocks = filteredStocks.slice(0, 5).map(s => 
                `${s.symbol} (LTP: ${s.ltp.toFixed(2)}, Change: ${s.change.toFixed(2)}%)`
            ).join('\n');
            
            const emailText = `Top Losers OH Scanner Results\n\n` +
                `Scan Time: ${scanTimestamp}\n` +
                `Total FOSec Stocks: ${scanResult.totalFOSecStocks}\n` +
                `EQ Stocks with Open=High: ${filteredStocks.length}\n` +
                `Scan Duration: ${scanTime}s\n\n` +
                `Top 5 Stocks:\n${topStocks || 'None found'}\n\n` +
                `Full results attached as CSV.`;
            
            await sendEmail(
                `📉 Losers OH Scan Results - ${scanTimestamp}`,
                emailText,
                {
                    filename: `losers_oh_${scanTimestamp.replace(/[: ]/g, '_')}.csv`,
                    content: csv
                }
            );
        }
        
        return scanResult;
    } catch (error) {
        console.error('❌ Losers OH Scan failed:', error.response?.status || error.message);
        
        // Return empty result on failure instead of crashing
        const scanTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(now.getTime() + istOffset);
        const scanTimestamp = istDate.toISOString().replace('T', ' ').substring(0, 19) + ' IST';
        
        const errorResult = {
            id: Date.now(),
            scanTimestamp,
            totalFOSecStocks: 0,
            qualifiedStocks: 0,
            scanTime,
            stocks: [],
            error: error.response?.status === 403 ? 'Access blocked by NSE' : error.message
        };
        
        appendResult(LOSERS_RESULTS_FILE, errorResult);
        return errorResult;
    }
}

// ─── Scheduler (IST Times) ────────────────────────────────────────────────────
// FnO Scanner times: 09:17, 09:18, 09:19, 09:20, 09:21 IST
const FNO_SCAN_TIMES_IST = [
    { h: 9, m: 17 },
    { h: 9, m: 18 },
    { h: 9, m: 19 },
    { h: 9, m: 20 },
    { h: 9, m: 21 },
];

// Losers OH Scanner time - only 09:31 IST
const LOSERS_SCAN_TIME_IST = { h: 9, m: 31 };

function getISTHoursMinutes() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);
    return { h: ist.getUTCHours(), m: ist.getUTCMinutes(), day: ist.getUTCDay() };
}

function scheduleScans() {
    const checkInterval = setInterval(() => {
        const { h, m, day } = getISTHoursMinutes();
        if (day < 1 || day > 5) return; // Mon-Fri only

        // Check FnO scanner times
        const fnoMatch = FNO_SCAN_TIMES_IST.find(t => t.h === h && t.m === m);
        if (fnoMatch) {
            console.log(`⏰ FnO Scanner triggered at ${h}:${String(m).padStart(2,'0')} IST`);
            runFnoScan().catch(err => console.error('FnO scan error:', err));
        }

        // Check Losers OH scanner time (09:31 only)
        if (LOSERS_SCAN_TIME_IST.h === h && LOSERS_SCAN_TIME_IST.m === m) {
            console.log(`⏰ Losers OH Scanner triggered at ${h}:${String(m).padStart(2,'0')} IST`);
            runLosersOHScan().catch(err => console.error('Losers scan error:', err));
        }
    }, 60 * 1000);

    console.log('📅 Scheduler active:');
    console.log('   - FnO Scanner: 09:17, 09:18, 09:19, 09:20, 09:21 IST (Mon-Fri)');
    console.log('   - Losers OH Scanner: 09:31 IST ONLY (Mon-Fri)');
    return checkInterval;
}

// ─── CSV Generators ───────────────────────────────────────────────────────────

function generateFnoCSV(scanResult) {
    const lines = [];
    lines.push(`NSE FnO Options Scanner - ${scanResult.scanTimestamp}`);
    lines.push(`Expiry: ${scanResult.expiry}`);
    lines.push(`Total: ${scanResult.totalSymbols} | Scanned: ${scanResult.totalScannedSuccessfully} | Qualified: ${scanResult.stocksMeetingConditions} | Time: ${scanResult.scanTime}s`);
    lines.push('');
    lines.push('BULLISH TOP 10');
    lines.push('Rank,Symbol,CE_OL,PE_OH');
    scanResult.bullish.forEach((s, i) => lines.push(`${i + 1},${s.symbol},${s.ceOL},${s.peOH}`));
    lines.push('');
    lines.push('BEARISH TOP 10');
    lines.push('Rank,Symbol,PE_OL,CE_OH');
    scanResult.bearish.forEach((s, i) => lines.push(`${i + 1},${s.symbol},${s.peOL},${s.ceOH}`));
    return lines.join('\n');
}

function generateLosersCSV(scanResult) {
    const lines = [];
    lines.push(`Top Losers OH Scanner - ${scanResult.scanTimestamp}`);
    lines.push(`Total FOSec Stocks: ${scanResult.totalFOSecStocks} | EQ Stocks with Open=High: ${scanResult.qualifiedStocks} | Time: ${scanResult.scanTime}s`);
    lines.push('');
    lines.push('Symbol,Open,High,Low,LTP,Change %,Volume');
    scanResult.stocks.forEach(s => {
        lines.push(`${s.symbol},${s.open.toFixed(2)},${s.high.toFixed(2)},${s.low.toFixed(2)},${s.ltp.toFixed(2)},${s.change.toFixed(2)},${s.volume}`);
    });
    return lines.join('\n');
}

function generateAllCSV(allResults, type) {
    const lines = [];
    if (type === 'fno') {
        lines.push('Timestamp,Expiry,Type,Rank,Symbol,Col1,Col2');
        for (const r of allResults) {
            r.bullish.forEach((s, i) => lines.push(`${r.scanTimestamp},${r.expiry},BULLISH,${i+1},${s.symbol},${s.ceOL},${s.peOH}`));
            r.bearish.forEach((s, i) => lines.push(`${r.scanTimestamp},${r.expiry},BEARISH,${i+1},${s.symbol},${s.peOL},${s.ceOH}`));
        }
    } else {
        lines.push('Timestamp,Symbol,Open,High,Low,LTP,Change %,Volume');
        for (const r of allResults) {
            r.stocks.forEach(s => lines.push(`${r.scanTimestamp},${s.symbol},${s.open},${s.high},${s.low},${s.ltp},${s.change},${s.volume}`));
        }
    }
    return lines.join('\n');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// FnO Scanner Routes
app.get('/api/fno/scan', async (req, res) => {
    try {
        const result = await runFnoScan();
        res.json(result);
    } catch (error) {
        console.error('FnO scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fno/results', (req, res) => {
    try {
        const results = loadResults(FNO_RESULTS_FILE);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fno/results/latest', (req, res) => {
    try {
        const results = loadResults(FNO_RESULTS_FILE);
        res.json(results.length > 0 ? results[0] : null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fno/download/csv/:id', (req, res) => {
    try {
        const results = loadResults(FNO_RESULTS_FILE);
        const result = results.find(r => String(r.id) === String(req.params.id));
        if (!result) return res.status(404).json({ error: 'Scan not found' });
        const csv = generateFnoCSV(result);
        const filename = `fno_scan_${result.scanTimestamp.replace(/[: ]/g, '_')}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fno/download/csv/all', (req, res) => {
    try {
        const results = loadResults(FNO_RESULTS_FILE);
        if (results.length === 0) return res.status(404).json({ error: 'No results' });
        const csv = generateAllCSV(results, 'fno');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="fno_all_scans.csv"');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Losers OH Scanner Routes
app.get('/api/losers/scan', async (req, res) => {
    try {
        const result = await runLosersOHScan();
        res.json(result);
    } catch (error) {
        console.error('Losers scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/losers/results', (req, res) => {
    try {
        const results = loadResults(LOSERS_RESULTS_FILE);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/losers/results/latest', (req, res) => {
    try {
        const results = loadResults(LOSERS_RESULTS_FILE);
        res.json(results.length > 0 ? results[0] : null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/losers/download/csv/:id', (req, res) => {
    try {
        const results = loadResults(LOSERS_RESULTS_FILE);
        const result = results.find(r => String(r.id) === String(req.params.id));
        if (!result) return res.status(404).json({ error: 'Scan not found' });
        const csv = generateLosersCSV(result);
        const filename = `losers_oh_${result.scanTimestamp.replace(/[: ]/g, '_')}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/losers/download/csv/all', (req, res) => {
    try {
        const results = loadResults(LOSERS_RESULTS_FILE);
        if (results.length === 0) return res.status(404).json({ error: 'No results' });
        const csv = generateAllCSV(results, 'losers');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="losers_all_scans.csv"');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    scheduleScans();
});
