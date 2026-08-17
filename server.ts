import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import AdmZip from "adm-zip";
import xml2js from "xml2js";
import dotenv from "dotenv";
import duckdb from "duckdb";

dotenv.config();

const API_KEY = process.env.DART_API_KEY;
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN;
const PORT = 3000;

async function startServer() {
  console.log("Starting server...");
  const app = express();
  app.use(express.json());

  // API Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", duckdb: !!db });
  });

  // DuckDB connection
  let db: duckdb.Database;
  const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN;
  const dbName = "dart_financials";

  try {
    // MotherDuck 연결 문자열 설정
    const dbPath = MOTHERDUCK_TOKEN ? `md:${dbName}?motherduck_token=${MOTHERDUCK_TOKEN}` : "financial_data.duckdb";
    console.log(`Connecting to: ${MOTHERDUCK_TOKEN ? "MotherDuck (md:" + dbName + ")" : "Local DuckDB (" + dbPath + ")"}`);
    db = new duckdb.Database(dbPath);
  } catch (err) {
    console.error("DuckDB Connection Error:", err);
    db = new duckdb.Database(":memory:");
  }
  
  // Promisify db.all and db.run
  const dbAll = (query: string, params: any[] = []): Promise<any[]> => {
    return new Promise((resolve, reject) => {
      db.all(query, ...params, (err, rows) => {
        if (err) {
          console.error(`Query Error: ${query}`, err);
          reject(err);
        } else resolve(rows);
      });
    });
  };

  const dbRun = (query: string, params: any[] = []): Promise<void> => {
    return new Promise((resolve, reject) => {
      db.run(query, ...params, (err) => {
        if (err) {
          console.error(`Execution Error: ${query}`, err);
          reject(err);
        } else resolve();
      });
    });
  };

  // Helper to parse DART numbers safely (handles commas and parentheses for negatives)
  function parseDartAmount(val: any): number {
    if (val === null || val === undefined) return 0;
    let s = val.toString().trim().replace(/,/g, "");
    if (s.startsWith("(") && s.endsWith(")")) {
      s = "-" + s.substring(1, s.length - 1);
    }
    const parsed = parseInt(s);
    return isNaN(parsed) ? 0 : parsed;
  }

  // Initialize DB Schema (Exact match with Python)
  async function initDb() {
    try {
      if (MOTHERDUCK_TOKEN) {
        await dbRun(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
      }

      await dbRun(`
        CREATE TABLE IF NOT EXISTS cached_financials (
          corp_code VARCHAR,
          year INTEGER,
          quarter INTEGER,
          report_code VARCHAR,
          fs_div VARCHAR,
          account_id VARCHAR,
          account_nm VARCHAR,
          thstrm_amount BIGINT,
          source VARCHAR,
          PRIMARY KEY (corp_code, year, report_code, fs_div, account_id)
        )
      `);
      
      // Safety check to add source column if table existed but column was missing
      const tableInfo = await dbAll("PRAGMA table_info('cached_financials')") as any[];
      const hasSource = tableInfo.some(col => col.name === 'source');
      if (!hasSource) {
        try {
          await dbRun("ALTER TABLE cached_financials ADD COLUMN source VARCHAR");
        } catch (e) {
          // Ignore if somehow already added between check and execution
        }
      }

      await dbRun(`
        CREATE TABLE IF NOT EXISTS corp_codes (
          corp_code VARCHAR PRIMARY KEY,
          corp_name VARCHAR,
          stock_code VARCHAR,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await dbRun(`
        CREATE TABLE IF NOT EXISTS processing_status (
          corp_code VARCHAR PRIMARY KEY,
          corp_name VARCHAR,
          last_base_period VARCHAR,
          status VARCHAR DEFAULT 'SUCCESS',
          processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("Database initialized");
    } catch (e) {
      console.error("Database initialization error:", e);
    }
  }

  await initDb();

  let corpCodesCached: any[] = [];

  async function loadCorpCodes() {
    try {
      const rows = await dbAll("SELECT corp_code, corp_name, stock_code FROM corp_codes");
      if (rows.length > 0) {
        corpCodesCached = rows;
        return rows;
      }
      return await syncCorpCodes();
    } catch (e) {
      return await syncCorpCodes();
    }
  }

  async function syncCorpCodes() {
    if (!API_KEY) return [];
    try {
      console.log("Syncing corp codes from API...");
      const response = await axios.get("https://opendart.fss.or.kr/api/corpCode.xml", {
        params: { crtfc_key: API_KEY },
        responseType: "arraybuffer",
      });
      
      const zip = new AdmZip(response.data);
      const xmlEntry = zip.getEntries()[0];
      const xmlData = xmlEntry.getData().toString("utf8");
      
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlData);
      
      let list = result.result.list;
      if (!Array.isArray(list)) list = list ? [list] : [];

      const codes = list
        .filter((item: any) => item.stock_code && item.stock_code.trim() !== "")
        .map((item: any) => ({
          corp_code: item.corp_code,
          corp_name: item.corp_name,
          stock_code: item.stock_code,
        }));
      
      for (const c of codes) {
        await dbRun("INSERT OR REPLACE INTO corp_codes (corp_code, corp_name, stock_code) VALUES (?, ?, ?)", [c.corp_code, c.corp_name, c.stock_code]);
      }

      corpCodesCached = codes;
      return codes;
    } catch (error) {
      console.error("Corp sync error:", error);
      return [];
    }
  }

  loadCorpCodes();

  // DB Status API
  app.get("/api/db-status", async (req, res) => {
    try {
      // 1. Total listed companies
      const totalCorpRows = await dbAll("SELECT COUNT(DISTINCT corp_code) as total FROM corp_codes");
      const totalCompanies = Number(totalCorpRows[0]?.total || 0);

      // 2. Companies with cached financial data
      const savedCorpRows = await dbAll("SELECT COUNT(DISTINCT corp_code) as saved, COUNT(*) as total_records FROM cached_financials");
      const savedCompanies = Number(savedCorpRows[0]?.saved || 0);
      const totalRecords = Number(savedCorpRows[0]?.total_records || 0);
      const missingCompanies = Math.max(0, totalCompanies - savedCompanies);
      const coverageRate = totalCompanies > 0 ? Number(((savedCompanies / totalCompanies) * 100).toFixed(1)) : 0;

      // 3. Quarter stats
      const quarterRows = await dbAll(`
        SELECT 
          year, 
          quarter, 
          COUNT(DISTINCT corp_code) as company_count,
          COUNT(*) as record_count
        FROM cached_financials
        GROUP BY year, quarter
        ORDER BY year DESC, quarter DESC
        LIMIT 12
      `);

      const quarterStats = quarterRows.map(row => ({
        year: Number(row.year),
        quarter: Number(row.quarter),
        quarterLabel: `${row.year} Q${row.quarter}`,
        companyCount: Number(row.company_count),
        recordCount: Number(row.record_count)
      }));

      // 4. Source breakdown
      const sourceRows = await dbAll(`
        SELECT 
          COALESCE(source, '기타') as source, 
          COUNT(DISTINCT corp_code) as company_count,
          COUNT(*) as record_count
        FROM cached_financials
        GROUP BY source
      `);

      const sourceStats = sourceRows.map(row => ({
        source: row.source,
        companyCount: Number(row.company_count),
        recordCount: Number(row.record_count)
      }));

      res.json({
        totalCompanies,
        savedCompanies,
        missingCompanies,
        coverageRate,
        totalRecords,
        quarterStats,
        recentQuarter: quarterStats[0] || null,
        previousQuarter: quarterStats[1] || null,
        sourceStats
      });
    } catch (error) {
      console.error("DB Status error:", error);
      res.status(500).json({ error: "Failed to fetch DB status" });
    }
  });

  app.get("/api/search-company", async (req, res) => {
    const { name } = req.query;
    if (!name) return res.json([]);
    if (corpCodesCached.length === 0) await loadCorpCodes();
    const searchTerm = (name as string).toLowerCase();
    const results = corpCodesCached.filter(c => c.corp_name.toLowerCase().includes(searchTerm)).slice(0, 10);
    res.json(results);
  });

  app.get("/api/financials", async (req, res) => {
    const { corp_code, year_month } = req.query;
    if (!API_KEY || !corp_code || !year_month) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const ym = parseInt(year_month as string);
    const targetYear = Math.floor(ym / 100);
    const targetMonth = ym % 100;
    
    let lastQ = 4;
    if (targetMonth <= 3) lastQ = 1;
    else if (targetMonth <= 6) lastQ = 2;
    else if (targetMonth <= 9) lastQ = 3;

    const startYear = targetYear - 4;
    const reports = [
      { name: "1분기보고서", code: "11013", q: 1 },
      { name: "반기보고서", code: "11012", q: 2 },
      { name: "3분기보고서", code: "11014", q: 3 },
      { name: "사업보고서", code: "11011", q: 4 },
    ];

    const tasks: any[] = [];
    for (let y = startYear; y <= targetYear; y++) {
      for (const r of reports) {
        if (y === targetYear && r.q > lastQ) continue;
        tasks.push({ year: y, report: r });
      }
    }

    try {
      // 1. Probing (Python: Probing logic)
      let determinedFsDiv = "CFS";
      const probeTask = tasks[tasks.length - 1]; // 최신 보고서 사용
      
      const checkApi = async (div: string) => {
        try {
          const r = await axios.get("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json", {
            params: { crtfc_key: API_KEY, corp_code, bsns_year: probeTask.year, reprt_code: probeTask.report.code, fs_div: div },
            timeout: 10000
          });
          return r.data.status === "000" && r.data.list;
        } catch (_) { return false; }
      };

      if (!(await checkApi("CFS"))) {
        if (await checkApi("OFS")) determinedFsDiv = "OFS";
      }

      // 2. Fetch with DB-First strategy
      const fetchData = async (year: number, report: any) => {
        // [MotherDuck Priority]
        try {
          const cache = await dbAll(
            "SELECT account_id, account_nm, thstrm_amount, source FROM cached_financials WHERE corp_code = ? AND year = ? AND report_code = ? AND fs_div = ?",
            [corp_code as string, year, report.code, determinedFsDiv]
          );

          if (cache && cache.length > 0) {
            // Use the source stored in DB, fallback to MotherDuck if not specified
            return { 
              year, quarter: report.q, div: determinedFsDiv, source: cache[0].source || "MotherDuck",
              data: cache.map(c => ({ account_id: c.account_id, account_nm: c.account_nm, thstrm_amount: c.thstrm_amount.toString() }))
            };
          }
        } catch (e) {
          console.error(`DB Query Fail for ${year} Q${report.q}:`, e);
        }

        // [API Fallback]
        try {
          const res = await axios.get("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json", {
            params: { crtfc_key: API_KEY, corp_code, bsns_year: year, reprt_code: report.code, fs_div: determinedFsDiv },
            timeout: 15000
          });

          if (res.data.status === "000" && res.data.list) {
            const list = res.data.list;
            const targetIds = ['ifrs-full_Revenue', 'dart_OperatingIncomeLoss'];
            const filtered = list.filter((i: any) => targetIds.includes(i.account_id));

            for (const item of filtered) {
              const val = parseDartAmount(item.thstrm_amount);
              await dbRun(`
                INSERT OR REPLACE INTO cached_financials (corp_code, year, quarter, report_code, fs_div, account_id, account_nm, thstrm_amount, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [corp_code as string, year, report.q, report.code, determinedFsDiv, item.account_id, item.account_nm, val, "DART API"]);
            }
            return { year, quarter: report.q, data: filtered, div: determinedFsDiv, source: "DART API" };
          }
        } catch (e) {
          console.error(`Fetch fail: ${year} Q${report.q}`, e);
        }
        return null;
      };

      const finalResults: any[] = [];
      const batchSize = 4;
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        const batchRes = await Promise.all(batch.map(t => fetchData(t.year, t.report)));
        finalResults.push(...batchRes.filter(r => r !== null));
      }

      // Update status (Python logic)
      const company = corpCodesCached.find(c => c.corp_code === corp_code);
      await dbRun(`
        INSERT OR REPLACE INTO processing_status (corp_code, corp_name, last_base_period, status, processed_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [corp_code as string, company?.corp_name || "Unknown", year_month as string, finalResults.length > 0 ? "SUCCESS" : "NOT_FOUND"]);

      res.json(finalResults);
    } catch (error) {
      console.error("Global fetch error:", error);
      res.status(500).json({ error: "Service Error" });
    }
  });

  app.get("/api/conditional-search", async (req, res) => {
    const { year_month, quarters_count, apply_min, min_margin, apply_max, max_margin, apply_avg, avg_margin } = req.query;
    if (!year_month || !quarters_count) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const ym = parseInt(year_month as string);
    const quartersCount = parseInt(quarters_count as string);
    const applyMin = apply_min === "true";
    const reqMinMargin = parseFloat(min_margin as string || "0");
    const applyMax = apply_max === "true";
    const reqMaxMargin = parseFloat(max_margin as string || "100");
    const applyAvg = apply_avg === "true";
    const reqAvgMargin = parseFloat(avg_margin as string || "0");

    const targetYear = Math.floor(ym / 100);
    const targetMonth = ym % 100;

    let lastQ = 4;
    if (targetMonth <= 3) lastQ = 1;
    else if (targetMonth <= 6) lastQ = 2;
    else if (targetMonth <= 9) lastQ = 3;

    // Determine target quarters (newest to oldest)
    const quartersToFetch: { year: number; quarter: number }[] = [];
    let currYear = targetYear;
    let currQ = lastQ;

    for (let i = 0; i < quartersCount; i++) {
      quartersToFetch.push({ year: currYear, quarter: currQ });
      currQ--;
      if (currQ === 0) {
        currQ = 4;
        currYear--;
      }
    }

    const years = Array.from(new Set(quartersToFetch.map(q => q.year)));
    if (years.length === 0) {
      return res.json({ quarters: [], results: [] });
    }

    try {
      // Query cached financials for these years from DuckDB
      const rows = await dbAll(`
        SELECT 
          f.corp_code, 
          c.corp_name,
          c.stock_code,
          f.year, 
          f.quarter, 
          f.account_id, 
          f.thstrm_amount, 
          f.source,
          f.fs_div
        FROM cached_financials f
        JOIN corp_codes c ON f.corp_code = c.corp_code
        WHERE f.year IN (${years.map(y => parseInt(y.toString())).join(',')})
          AND f.account_id IN ('ifrs-full_Revenue', 'dart_OperatingIncomeLoss')
      `);

      // Group by company
      const companiesData: Record<string, { 
        corp_code: string; 
        corp_name: string; 
        stock_code: string;
        quarters: Record<number, Record<number, { rev: number; op: number; source?: string; fs_div?: string }>> 
      }> = {};

      for (const row of rows) {
        const { corp_code, corp_name, stock_code, year, quarter, account_id, thstrm_amount, source, fs_div } = row;
        if (!companiesData[corp_code]) {
          companiesData[corp_code] = {
            corp_code,
            corp_name,
            stock_code,
            quarters: {}
          };
        }
        if (!companiesData[corp_code].quarters[year]) {
          companiesData[corp_code].quarters[year] = {};
        }

        const existing = companiesData[corp_code].quarters[year][quarter];
        
        // Prefer CFS over OFS
        if (existing && existing.fs_div === 'CFS' && fs_div === 'OFS') {
          continue;
        }

        if (existing && existing.fs_div === 'OFS' && fs_div === 'CFS') {
          companiesData[corp_code].quarters[year][quarter] = {
            rev: 0,
            op: 0,
            source: source || "MotherDuck",
            fs_div: 'CFS'
          };
        } else if (!existing) {
          companiesData[corp_code].quarters[year][quarter] = {
            rev: 0,
            op: 0,
            source: source || "MotherDuck",
            fs_div: fs_div
          };
        }

        if (account_id === 'ifrs-full_Revenue') {
          companiesData[corp_code].quarters[year][quarter].rev = Number(thstrm_amount);
        } else if (account_id === 'dart_OperatingIncomeLoss') {
          companiesData[corp_code].quarters[year][quarter].op = Number(thstrm_amount);
        }
      }

      // Calculate standalone values for each company and year/quarter
      const companyStandaloneQuarters: Record<string, Record<string, { rev: number; op: number; margin: number }>> = {};

      for (const [corp_code, cData] of Object.entries(companiesData)) {
        companyStandaloneQuarters[corp_code] = {};
        
        for (const [yearStr, qValues] of Object.entries(cData.quarters)) {
          const year = parseInt(yearStr);
          
          for (let q = 1; q <= 4; q++) {
            if (!qValues[q]) continue;
            
            let standaloneRev = qValues[q].rev;
            let standaloneOp = qValues[q].op;
            const qSource = qValues[q].source || "MotherDuck";
            
            if (qSource === 'MotherDuck') {
              if (q === 4) {
                const q13RevSum = (qValues[1]?.rev || 0) + (qValues[2]?.rev || 0) + (qValues[3]?.rev || 0);
                const q13OpSum = (qValues[1]?.op || 0) + (qValues[2]?.op || 0) + (qValues[3]?.op || 0);
                standaloneRev = qValues[q].rev - q13RevSum;
                standaloneOp = qValues[q].op - q13OpSum;
              }
            } else {
              if (q > 1) {
                let prevCumRev = 0;
                let prevCumOp = 0;
                for (let pq = q - 1; pq >= 1; pq--) {
                  if (qValues[pq]) {
                    prevCumRev = qValues[pq].rev;
                    prevCumOp = qValues[pq].op;
                    break;
                  }
                }
                standaloneRev = qValues[q].rev - prevCumRev;
                standaloneOp = qValues[q].op - prevCumOp;
              }
            }
            
            const margin = standaloneRev !== 0 ? (standaloneOp / standaloneRev) * 100 : 0;
            companyStandaloneQuarters[corp_code][`${year}-${q}`] = {
              rev: standaloneRev,
              op: standaloneOp,
              margin
            };
          }
        }
      }

      // Filter matching companies based on min / avg criteria
      const matchingCompanies: any[] = [];

      for (const [corp_code, cData] of Object.entries(companiesData)) {
        const marginsList: number[] = [];
        let availableQuartersCount = 0;
        
        for (const target of quartersToFetch) {
          const qKey = `${target.year}-${target.quarter}`;
          const qData = companyStandaloneQuarters[corp_code][qKey];
          if (qData) {
            marginsList.push(qData.margin);
            availableQuartersCount++;
          } else {
            // Put a placeholder margin or 0 if missing, but let's see if we enforce full consecutive count
            marginsList.push(0);
          }
        }

        // We require full data of quartersCount to avoid displaying incomplete records
        if (availableQuartersCount < quartersCount) {
          continue;
        }

        const minMargin = Math.min(...marginsList);
        const maxMargin = Math.max(...marginsList);
        const avgMargin = marginsList.reduce((sum, val) => sum + val, 0) / marginsList.length;
        
        let satisfies = true;
        if (applyMin) {
          if (minMargin < reqMinMargin) satisfies = false;
        }
        if (applyMax) {
          if (maxMargin > reqMaxMargin) satisfies = false;
        }
        if (applyAvg) {
          if (avgMargin < reqAvgMargin) satisfies = false;
        }
        
        if (satisfies) {
          matchingCompanies.push({
            corp_code: cData.corp_code,
            corp_name: cData.corp_name,
            stock_code: cData.stock_code,
            margins: marginsList, // newest to oldest
            minMargin,
            maxMargin,
            avgMargin,
            quartersCount: availableQuartersCount
          });
        }
      }

      // Sort by avgMargin descending
      matchingCompanies.sort((a, b) => b.avgMargin - a.avgMargin);

      res.json({
        quarters: quartersToFetch.map(q => `${q.year} Q${q.quarter}`),
        results: matchingCompanies
      });
    } catch (error) {
      console.error("Conditional search error:", error);
      res.status(500).json({ error: "Service Error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
