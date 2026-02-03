const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// THIS IS THE KEY LINE - serve static files from current directory
app.use(express.static(path.join(__dirname)));

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/option-chain',
    'Origin': 'https://www.nseindia.com/option-chain',
};

// ... rest of your code stays the same ...
// (Keep all the Semaphore, fetchFnoSymbols, checkFutstkCondition, getCountsForSymbol functions)

class Semaphore {
    constructor(max) {
        this.max = max;
        this.count = 0;
        this.queue = [];
    }

    async acquire() {
        if (this.count < this.max) {
            this.count++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
    }

    release() {
        this.count--;
        if (this.queue.length > 0) {
            this.count++;
            const resolve = this.queue.shift();
            resolve();
        }
    }
}

async function fetchFnoSymbols(axiosInstance) {
    const url = "https://www.nseindia.com/api/underlying-information?segment=equity";
    const response = await axiosInstance.get(url);
    
    if (response.status !== 200) {
        throw new Error(`Failed to fetch symbols HTTP ${response.status}`);
    }

    const data = response.data;
    const underlyingList = data?.data?.UnderlyingList || [];
    const symbols = underlyingList
        .filter(row => typeof row === 'object' && row !== null && row.symbol)
        .map(row => row.symbol.trim());

    symbols.sort();
    return symbols;
}

function checkFutstkCondition(record, targetExpiry) {
    const instrumentType = record.instrumentType || '';
    const expiryDate = record.expiryDate;

    if (instrumentType === 'FUTSTK' && expiryDate === targetExpiry) {
        const openPrice = record.openPrice || 0;
        const prevClose = record.prevClose || 0;

        if (prevClose > 0) {
            const percentageDiff = ((openPrice - prevClose) / prevClose) * 100;
            if (percentageDiff >= -0.5 && percentageDiff <= 0.5) {
                return true;
            }
        }
    }
    return false;
}

async function getCountsForSymbol(axiosInstance, symbol, semaphore) {
    const url = `https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolDerivativesData&symbol=${symbol}`;

    await semaphore.acquire();
    
    try {
        const response = await axiosInstance.get(url, { timeout: 10000 });
        
        if (response.status === 200) {
            const data = response.data;
            const records = data.data || [];
            const targetExpiry = "24-Feb-2026";

            let futstkConditionMet = false;
            for (const record of records) {
                if (checkFutstkCondition(record, targetExpiry)) {
                    futstkConditionMet = true;
                    break;
                }
            }

            if (!futstkConditionMet) {
                return [symbol, 0, 0, 0, 0, "FUTSTK condition not met"];
            }

            let callOpenLow = 0;
            let callOpenHigh = 0;
            let putOpenLow = 0;
            let putOpenHigh = 0;

            for (const record of records) {
                if (record.expiryDate !== targetExpiry) continue;
                if (record.instrumentType !== 'OPTSTK') continue;

                const openPrice = record.openPrice || 0;
                if (openPrice <= 0) continue;
                if ((record.totalTradedVolume || 0) <= 0) continue;

                const optionType = (record.optionType || '').toUpperCase();

                if (optionType === 'CE') {
                    if (openPrice === record.lowPrice) callOpenLow += 1;
                    if (openPrice === record.highPrice) callOpenHigh += 1;
                } else if (optionType === 'PE') {
                    if (openPrice === record.lowPrice) putOpenLow += 1;
                    if (openPrice === record.highPrice) putOpenHigh += 1;
                }
            }

            return [symbol, callOpenLow, callOpenHigh, putOpenLow, putOpenHigh, "Success"];
        } else {
            return [symbol, 0, 0, 0, 0, `HTTP ${response.status}`];
        }
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            return [symbol, 0, 0, 0, 0, "Timeout"];
        }
        return [symbol, 0, 0, 0, 0, `Error: ${error.message}`];
    } finally {
        semaphore.release();
    }
}

app.get('/api/scan', async (req, res) => {
    try {
        const startTime = Date.now();

        const axiosInstance = axios.create({
            headers: headers,
            timeout: 15000,
        });

        try {
            await axiosInstance.get("https://www.nseindia.com", { timeout: 5000 });
        } catch (error) {
            // Ignore error
        }

        const symbols = await fetchFnoSymbols(axiosInstance);

        const semaphore = new Semaphore(10);
        const tasks = symbols.map(symbol => getCountsForSymbol(axiosInstance, symbol, semaphore));
        const results = await Promise.all(tasks);

        let totalScannedSuccessfully = 0;
        let stocksMeetingConditions = 0;
        const group1 = [];
        const group2 = [];

        for (const [symbol, callOpenLow, callOpenHigh, putOpenLow, putOpenHigh, status] of results) {
            if (status.includes("HTTP") || status.includes("Timeout") || status.includes("Error")) {
                continue;
            }

            totalScannedSuccessfully += 1;

            if (status === "Success") {
                stocksMeetingConditions += 1;
                group1.push({ symbol, ceOL: callOpenLow, peOH: putOpenHigh });
                group2.push({ symbol, peOL: putOpenLow, ceOH: callOpenHigh });
            }
        }

        group1.sort((a, b) => b.ceOL - a.ceOL);
        group2.sort((a, b) => b.peOL - a.peOL);

        const scanTime = ((Date.now() - startTime) / 1000).toFixed(2);

        res.json({
            totalSymbols: symbols.length,
            totalScannedSuccessfully,
            stocksMeetingConditions,
            scanTime,
            bullish: group1.slice(0, 10),
            bearish: group2.slice(0, 10)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});