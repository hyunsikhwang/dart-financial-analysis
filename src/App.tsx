import { useState, useEffect, useMemo, type ReactNode } from 'react';
import axios from 'axios';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, 
  ResponsiveContainer, LineChart, Line, ComposedChart, Cell
} from 'recharts';
import { Search, TrendingUp, Calendar, Building2, Loader2, AlertCircle, ArrowUpRight, BarChart3, List, ArrowUpDown, SlidersHorizontal, Filter } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface FinancialData {
  기간: string;
  매출액: number;
  영업이익: number;
  영업이익률: number;
  year: number;
  quarter: number;
  source?: string;
}

interface Company {
  corp_code: string;
  corp_name: string;
  stock_code: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'individual' | 'conditional'>('individual');
  const [searchTerm, setSearchTerm] = useState('');
  const [baseDate, setBaseDate] = useState('202603');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCorp, setSelectedCorp] = useState<Company | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [financials, setFinancials] = useState<FinancialData[]>([]);
  const [chartViewMode, setChartViewMode] = useState<'standalone' | 'cumulative'>('standalone');
  const [error, setError] = useState<string | null>(null);

  const chartData = useMemo(() => {
    if (chartViewMode === 'standalone') {
      return financials;
    }
    
    return financials.map((item, index) => {
      const startIdx = Math.max(0, index - 3);
      const subset = financials.slice(startIdx, index + 1);
      
      const sumRev = subset.reduce((acc, curr) => acc + curr.매출액, 0);
      const sumOp = subset.reduce((acc, curr) => acc + curr.영업이익, 0);
      const margin = sumRev !== 0 ? (sumOp / sumRev) * 100 : 0;
      
      return {
        ...item,
        매출액: sumRev,
        영업이익: sumOp,
        영업이익률: margin,
        isPartial: subset.length < 4,
        accumulatedQuarters: subset.length
      };
    });
  }, [financials, chartViewMode]);

  // States for conditional search
  const [quartersCount, setQuartersCount] = useState(4);
  const [applyMin, setApplyMin] = useState(true);
  const [minMargin, setMinMargin] = useState(10.00);
  const [applyMax, setApplyMax] = useState(false);
  const [maxMargin, setMaxMargin] = useState(50.00);
  const [applyAvg, setApplyAvg] = useState(false);
  const [avgMargin, setAvgMargin] = useState(10.00);
  const [conditionalResults, setConditionalResults] = useState<any[]>([]);
  const [conditionalQuarters, setConditionalQuarters] = useState<string[]>([]);
  const [conditionalLoading, setConditionalLoading] = useState(false);
  const [conditionalError, setConditionalError] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState('');
  const [sortField, setSortField] = useState<string>('avgMargin');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showColumnFilters, setShowColumnFilters] = useState(false);
  const [colFilters, setColFilters] = useState({
    corp: '',
    avgMin: '',
    avgMax: '',
    minMin: '',
    minMax: '',
    maxMin: '',
    maxMax: '',
  });

  const handleConditionalSearch = async () => {
    setLocalFilter('');
    setSortField('avgMargin');
    setSortDirection('desc');
    setColFilters({
      corp: '',
      avgMin: '',
      avgMax: '',
      minMin: '',
      minMax: '',
      maxMin: '',
      maxMax: '',
    });
    setConditionalLoading(true);
    setConditionalError(null);
    try {
      const res = await axios.get('/api/conditional-search', {
        params: {
          year_month: baseDate,
          quarters_count: quartersCount,
          apply_min: applyMin,
          min_margin: minMargin,
          apply_max: applyMax,
          max_margin: maxMargin,
          apply_avg: applyAvg,
          avg_margin: avgMargin
        }
      });
      setConditionalResults(res.data.results || []);
      setConditionalQuarters(res.data.quarters || []);
    } catch (err) {
      setConditionalError('검색 중 오류가 발생했습니다.');
    } finally {
      setConditionalLoading(false);
    }
  };

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      if (searchTerm.length >= 2) {
        searchCompanies();
      }
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchTerm]);

  const searchCompanies = async () => {
    setSearching(true);
    try {
      const res = await axios.get(`/api/search-company?name=${encodeURIComponent(searchTerm)}`);
      setCompanies(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error(err);
      setCompanies([]);
    } finally {
      setSearching(false);
    }
  };

  const fetchFinancials = async (corp: Company) => {
    setSelectedCorp(corp);
    setCompanies([]);
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`/api/financials?corp_code=${corp.corp_code}&year_month=${baseDate}`);
      const rawData = res.data;

      if (!rawData || rawData.length === 0) {
        setError('해당 기간의 재무 데이터를 찾을 수 없습니다.');
        setFinancials([]);
        return;
      }

      // Process raw data into quarterly values
      const processed = processRawFinancials(rawData);
      setFinancials(processed);
    } catch (err) {
      setError('데이터를 가져오는 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const processRawFinancials = (data: any[]): FinancialData[] => {
    const itemMap: Record<string, string> = {
      'ifrs-full_Revenue': '매출액',
      'dart_OperatingIncomeLoss': '영업이익'
    };

    const parseVal = (val: any): number => {
      if (val === null || val === undefined) return 0;
      let s = val.toString().trim().replace(/,/g, '');
      if (s.startsWith('(') && s.endsWith(')')) {
        s = '-' + s.substring(1, s.length - 1);
      }
      const parsed = parseFloat(s);
      return isNaN(parsed) ? 0 : parsed;
    };

    // Group by year and quarter
    const grouped: any = {};
    data.forEach(item => {
      const key = `${item.year}-${item.quarter}`;
      if (!grouped[key]) grouped[key] = { year: item.year, quarter: item.quarter, values: {}, source: item.source };
      
      item.data.forEach((entry: any) => {
        if (itemMap[entry.account_id]) {
          grouped[key].values[itemMap[entry.account_id]] = parseVal(entry.thstrm_amount);
        }
      });
    });

    const years = Array.from(new Set(data.map(d => d.year))).sort((a, b) => a - b);
    const result: FinancialData[] = [];

    years.forEach(year => {
      const qCumValues: Record<number, { rev: number, op: number, source?: string }> = {};
      [1, 2, 3, 4].forEach(q => {
        const key = `${year}-${q}`;
        if (grouped[key]) {
          qCumValues[q] = {
            rev: grouped[key].values['매출액'] || 0,
            op: grouped[key].values['영업이익'] || 0,
            source: grouped[key].source
          };
        }
      });

      [1, 2, 3, 4].forEach(q => {
        if (qCumValues[q]) {
          let standaloneRev = qCumValues[q].rev;
          let standaloneOp = qCumValues[q].op;

          // Calculate standalone values based on source and quarter
          if (qCumValues[q].source === 'MotherDuck') {
            // User instruction: MD Q1, Q2, Q3 are standalone, Q4 is cumulative (Q1+Q2+Q3+Q4)
            if (q === 4) {
              const q13RevSum = (qCumValues[1]?.rev || 0) + (qCumValues[2]?.rev || 0) + (qCumValues[3]?.rev || 0);
              const q13OpSum = (qCumValues[1]?.op || 0) + (qCumValues[2]?.op || 0) + (qCumValues[3]?.op || 0);
              standaloneRev = qCumValues[q].rev - q13RevSum;
              standaloneOp = qCumValues[q].op - q13OpSum;
            }
            // else: Q1, Q2, Q3 remain as standalone Rev/Op
          } else {
            // DART API returns cumulative values for all quarters
            if (q > 1) {
              let prevCumRev = 0;
              let prevCumOp = 0;
              for (let pq = q - 1; pq >= 1; pq--) {
                if (qCumValues[pq]) {
                  prevCumRev = qCumValues[pq].rev;
                  prevCumOp = qCumValues[pq].op;
                  break;
                }
              }
              standaloneRev = qCumValues[q].rev - prevCumRev;
              standaloneOp = qCumValues[q].op - prevCumOp;
            }
          }

          result.push({
            기간: `${year}년 ${q}분기`,
            매출액: Math.round(standaloneRev / 1000000), 
            영업이익: Math.round(standaloneOp / 1000000),
            영업이익률: standaloneRev !== 0 ? (standaloneOp / standaloneRev) * 100 : 0,
            year,
            quarter: q,
            source: qCumValues[q].source
          });
        }
      });
    });

    return result.sort((a, b) => a.year !== b.year ? a.year - b.year : a.quarter - b.quarter);
  };

  const sortedAndFilteredResults = [...conditionalResults]
    .filter(row => {
      // 1. Global filter
      const matchesGlobal = !localFilter || 
        row.corp_name.toLowerCase().includes(localFilter.toLowerCase()) || 
        row.stock_code.toLowerCase().includes(localFilter.toLowerCase());
      if (!matchesGlobal) return false;

      // 2. Column-specific filters
      if (colFilters.corp && 
          !row.corp_name.toLowerCase().includes(colFilters.corp.toLowerCase()) && 
          !row.stock_code.toLowerCase().includes(colFilters.corp.toLowerCase())) {
        return false;
      }
      
      if (colFilters.avgMin !== '') {
        const val = parseFloat(colFilters.avgMin);
        if (isNaN(val) || row.avgMargin < val) return false;
      }
      if (colFilters.avgMax !== '') {
        const val = parseFloat(colFilters.avgMax);
        if (isNaN(val) || row.avgMargin > val) return false;
      }
      
      if (colFilters.minMin !== '') {
        const val = parseFloat(colFilters.minMin);
        if (isNaN(val) || row.minMargin < val) return false;
      }
      if (colFilters.minMax !== '') {
        const val = parseFloat(colFilters.minMax);
        if (isNaN(val) || row.minMargin > val) return false;
      }
      
      if (colFilters.maxMin !== '') {
        const val = parseFloat(colFilters.maxMin);
        if (isNaN(val) || row.maxMargin < val) return false;
      }
      if (colFilters.maxMax !== '') {
        const val = parseFloat(colFilters.maxMax);
        if (isNaN(val) || row.maxMargin > val) return false;
      }

      return true;
    })
    .sort((a, b) => {
      let valA: any;
      let valB: any;

      if (sortField === 'corp_name') {
        valA = a.corp_name;
        valB = b.corp_name;
      } else if (sortField === 'stock_code') {
        valA = a.stock_code;
        valB = b.stock_code;
      } else if (sortField === 'avgMargin') {
        valA = a.avgMargin;
        valB = b.avgMargin;
      } else if (sortField === 'minMargin') {
        valA = a.minMargin;
        valB = b.minMargin;
      } else if (sortField === 'maxMargin') {
        valA = a.maxMargin;
        valB = b.maxMargin;
      } else if (sortField.startsWith('quarter_')) {
        const qIndex = parseInt(sortField.replace('quarter_', ''));
        valA = a.margins[qIndex] !== undefined ? a.margins[qIndex] : -999999;
        valB = b.margins[qIndex] !== undefined ? b.margins[qIndex] : -999999;
      } else {
        valA = a.avgMargin;
        valB = b.avgMargin;
      }

      if (valA === valB) return 0;
      
      const multiplier = sortDirection === 'asc' ? 1 : -1;
      
      if (typeof valA === 'string' && typeof valB === 'string') {
        return valA.localeCompare(valB) * multiplier;
      }
      return (valA - valB) * multiplier;
    });

  return (
    <div className="min-h-screen bg-slate-50 font-sans selection:bg-blue-100">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <TrendingUp size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 uppercase">DART Financial Analysis</h1>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-slate-400">
            <span className="flex items-center gap-1"><AlertCircle size={14} /> Data provided by Open DART</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Tabs Bar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-1 flex mb-8 w-fit shadow-sm">
          <button 
            id="tab-individual"
            onClick={() => setActiveTab('individual')} 
            className={cn(
              "px-6 py-2.5 font-bold text-sm rounded-xl transition-all relative cursor-pointer",
              activeTab === 'individual' 
                ? "text-slate-900" 
                : "text-slate-400 hover:text-slate-600"
            )}
          >
            기업별 재무 조회
            {activeTab === 'individual' && (
              <motion.div layoutId="activeTabIndicator" className="absolute bottom-0 left-6 right-6 h-0.5 bg-blue-600" />
            )}
          </button>
          <button 
            id="tab-conditional"
            onClick={() => setActiveTab('conditional')} 
            className={cn(
              "px-6 py-2.5 font-bold text-sm rounded-xl transition-all relative cursor-pointer",
              activeTab === 'conditional' 
                ? "text-slate-900" 
                : "text-slate-400 hover:text-slate-600"
            )}
          >
            조건 검색
            {activeTab === 'conditional' && (
              <motion.div layoutId="activeTabIndicator" className="absolute bottom-0 left-6 right-6 h-0.5 bg-blue-600" />
            )}
          </button>
        </div>

        {activeTab === 'individual' ? (
          <>
            {/* Search Hero */}
            <div className="mb-8 text-center max-w-2xl mx-auto">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
              >
                <h2 className="text-4xl font-extrabold text-slate-900 mb-2 tracking-tight">DART Financial Analysis</h2>
                <p className="text-slate-500 text-sm mb-8 tracking-tight">국내 상장사들의 최근 5개년 분기별 매출 및 영업이익 추이를 한눈에 분석하세요.</p>
              </motion.div>

              <div className="flex flex-col md:flex-row gap-3 relative">
                <div className="flex-1 relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors">
                    <Building2 size={20} />
                  </div>
                  <input
                    type="text"
                    placeholder="회사명 검색 (예: 삼성전자)"
                    className="w-full h-10 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                  <AnimatePresence>
                    {searching && (
                      <motion.div 
                        initial={{ opacity: 0 }} 
                        animate={{ opacity: 1 }} 
                        exit={{ opacity: 0 }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300"
                      >
                        <Loader2 className="animate-spin" size={20} />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Autocomplete Dropdown */}
                  <AnimatePresence>
                    {companies.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-2xl shadow-xl z-10 overflow-hidden"
                      >
                        {companies.map((company) => (
                          <button
                            key={company.corp_code}
                            onClick={() => fetchFinancials(company)}
                            className="w-full text-left px-5 py-4 hover:bg-slate-50 flex items-center justify-between group transition-colors border-b border-slate-50 last:border-0 cursor-pointer"
                          >
                            <div>
                              <p className="font-semibold text-slate-900 group-hover:text-blue-600 transition-colors uppercase">{company.corp_name}</p>
                              <p className="text-xs text-slate-400">종목코드: {company.stock_code}</p>
                            </div>
                            <ArrowUpRight size={18} className="text-slate-200 group-hover:text-blue-400 transition-colors" />
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="w-full md:w-48 relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                    <Calendar size={18} />
                  </div>
                  <input
                    type="text"
                    placeholder="기준연월 (YYYYMM)"
                    className="w-full h-10 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm text-center"
                    value={baseDate}
                    onChange={(e) => setBaseDate(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Results Section */}
            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <Loader2 className="animate-spin text-blue-600" size={48} />
                <p className="text-slate-500 text-sm animate-pulse font-medium">재무 데이터를 상세 분석 중입니다...</p>
              </div>
            ) : error ? (
              <div className="bg-red-50 border border-red-100 rounded-2xl p-8 text-center max-w-lg mx-auto">
                <AlertCircle className="mx-auto text-red-400 mb-3" size={32} />
                <p className="text-red-800 font-semibold mb-1">{error}</p>
                <p className="text-red-600/60 text-sm">회사명과 기준연월을 확인 후 다시 시도해주세요.</p>
              </div>
            ) : financials.length > 0 && selectedCorp ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* Summary Title */}
                <div className="flex items-end justify-between px-2">
                  <div>
                    <span className="text-xs font-bold text-blue-600 uppercase tracking-widest mb-1 block">Analysis Report</span>
                    <h3 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                      {selectedCorp.corp_name}
                      <span className="text-sm font-medium text-slate-300">({selectedCorp.stock_code})</span>
                    </h3>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-400 uppercase font-bold tracking-tighter">Unit</p>
                    <p className="text-xs font-semibold text-slate-500">백만원 (KRW 1M)</p>
                  </div>
                </div>

                {/* Charts Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                      <div className="flex flex-wrap items-center gap-3">
                        <h4 className="font-bold text-slate-900 flex items-center gap-2">
                          <BarChart3 size={18} className="text-blue-500" />
                          실적 추이 보고서
                        </h4>
                        
                        {/* 차트 뷰 모드 토글 */}
                        <div className="inline-flex bg-slate-100 p-0.5 rounded-lg border border-slate-200/50">
                          <button
                            onClick={() => setChartViewMode('standalone')}
                            className={cn(
                              "px-2.5 py-1 rounded-md text-[11px] font-black cursor-pointer transition-all",
                              chartViewMode === 'standalone'
                                ? "bg-white text-slate-900 shadow-sm"
                                : "text-slate-400 hover:text-slate-600"
                            )}
                          >
                            분기별 실적
                          </button>
                          <button
                            onClick={() => setChartViewMode('cumulative')}
                            className={cn(
                              "px-2.5 py-1 rounded-md text-[11px] font-black cursor-pointer transition-all",
                              chartViewMode === 'cumulative'
                                ? "bg-white text-slate-900 shadow-sm"
                                : "text-slate-400 hover:text-slate-600"
                            )}
                          >
                            직전 4분기 누적
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-4">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                          <div className="w-2 h-2 rounded-full bg-slate-200" /> {chartViewMode === 'cumulative' ? '매출액 (누적)' : '매출액'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                          <div className="w-2 h-2 rounded-full bg-green-500" /> {chartViewMode === 'cumulative' ? '영업이익 (누적)' : '영업이익'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-600">
                          <div className="w-2 h-2 rounded-full bg-blue-600" /> {chartViewMode === 'cumulative' ? '영업이익률 (누적)' : '영업이익률'}
                        </div>
                      </div>
                    </div>
                    <div className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis 
                            dataKey="기간" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                            dy={10}
                          />
                          <YAxis 
                            yAxisId="left" 
                            orientation="left" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                            tickFormatter={(val) => `${(val / 1000).toFixed(0)}k`}
                          />
                          <YAxis 
                            yAxisId="right" 
                            orientation="right" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fill: '#007aff', fontSize: 11 }}
                            tickFormatter={(val) => `${val}%`}
                          />
                          <Tooltip 
                            contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.05)' }}
                            cursor={{ fill: '#f8fafc' }}
                            formatter={(value: any, name: any) => {
                              if (name === '영업이익률') return [`${Number(value).toFixed(1)}%`, name];
                              return [value.toLocaleString(), name];
                            }}
                          />
                          <Bar yAxisId="left" dataKey="매출액" fill="#e2e8f0" radius={[4, 4, 0, 0]} barSize={24} />
                          <Bar yAxisId="left" dataKey="영업이익" fill="#22c55e" radius={[4, 4, 0, 0]} barSize={24} />
                          <Line 
                            yAxisId="right" 
                            type="monotone" 
                            dataKey="영업이익률" 
                            stroke="#007aff" 
                            strokeWidth={3} 
                            dot={{ r: 4, fill: '#fff', stroke: '#007aff', strokeWidth: 2 }}
                            activeDot={{ r: 6 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Data Table */}
                  <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100 flex flex-col">
                    <h4 className="font-bold text-slate-900 flex items-center gap-2 mb-6">
                      <List size={18} className="text-slate-400" />
                      상세 지표 수치
                    </h4>
                    <div className="flex-1 overflow-auto max-h-[400px] scrollbar-hide">
                      <table className="w-full text-left">
                        <thead className="sticky top-0 bg-white">
                          <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-50">
                            <th className="pb-3 text-left">기간</th>
                            <th className="pb-3 text-right">{chartViewMode === 'cumulative' ? '매출액 (누적)' : '매출액'}</th>
                            <th className="pb-3 text-right">{chartViewMode === 'cumulative' ? '영업이익 (누적)' : '영업이익'}</th>
                            <th className="pb-3 text-right">{chartViewMode === 'cumulative' ? '이익률 (누적)' : '이익률'}</th>
                            <th className="pb-3 text-right">Source</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {[...chartData].reverse().map((row, idx) => (
                            <tr key={idx} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                              <td className="py-3 font-semibold text-slate-600">
                                {row.기간}
                                {chartViewMode === 'cumulative' && row.isPartial && (
                                  <span className="text-[9px] text-amber-500 font-bold block sm:inline sm:ml-1">({row.accumulatedQuarters}Q 누적)</span>
                                )}
                              </td>
                              <td className="py-3 text-right font-medium text-slate-900">{row.매출액.toLocaleString()}</td>
                              <td className="py-3 text-right font-medium text-slate-500">{row.영업이익.toLocaleString()}</td>
                              <td className={cn(
                                "py-3 text-right font-black",
                                row.영업이익률 > 0 ? "text-blue-600" : "text-red-500"
                              )}>
                                {row.영업이익률.toFixed(2)}%
                              </td>
                              <td className="py-3 text-right">
                                <span className={cn(
                                  "text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase",
                                  row.source === "MotherDuck" ? "bg-purple-100 text-purple-600" : "bg-slate-100 text-slate-500"
                                )}>
                                  {row.source === "MotherDuck" ? "MD" : "API"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Performance Stats Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard 
                    title={chartViewMode === 'cumulative' ? "평균 누적 영업이익률" : "평균 영업이익률"} 
                    value={`${(chartData.reduce((acc, curr) => acc + curr.영업이익률, 0) / chartData.length).toFixed(2)}%`}
                    icon={<TrendingUp size={20} />}
                    color="blue"
                  />
                  <StatCard 
                    title={chartViewMode === 'cumulative' ? "최대 4Q 누적 매출" : "최대 분기 매출"} 
                    value={`${Math.max(...chartData.map(f => f.매출액)).toLocaleString()}M`}
                    icon={<BarChart3 size={20} />}
                    color="slate"
                  />
                  <StatCard 
                    title={chartViewMode === 'cumulative' ? "최고 누적 영업이익률" : "분기 최고 이익률"} 
                    value={`${Math.max(...chartData.map(f => f.영업이익률)).toFixed(2)}%`}
                    icon={<TrendingUp size={20} />}
                    color="green"
                  />
                  <StatCard 
                    title="분석 대상 분기" 
                    value={`${chartData.length} Quarters`}
                    icon={<Calendar size={20} />}
                    color="slate"
                  />
                </div>
              </motion.div>
            ) : (
              <div className="py-24 text-center">
                <div className="w-20 h-20 bg-slate-100 rounded-3xl flex items-center justify-center mx-auto mb-6 text-slate-300">
                  <Search size={32} />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-1">Company Search</h3>
                <p className="text-slate-400 max-w-xs mx-auto">분석하고 싶은 기업의 이름을 상단 검색창에 입력하여 분석을 시작하세요.</p>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-6">
            {/* Unified Base Date display for Condition Search */}
            <div className="flex justify-between items-center max-w-4xl mx-auto px-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Conditional Query Filter</span>
              <div className="flex gap-2 items-center">
                <span className="text-xs font-bold text-slate-500">기준연월:</span>
                <input
                  type="text"
                  placeholder="기준연월"
                  className="w-24 h-8 px-2 bg-white border border-slate-200 rounded-xl text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-xs font-semibold"
                  value={baseDate}
                  onChange={(e) => setBaseDate(e.target.value)}
                />
              </div>
            </div>

            {/* Condition Panel matching screenshot */}
            <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60 max-w-4xl mx-auto">
              <div className="space-y-4">
                {/* Top Row: 분기수 & 설명 */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-black text-slate-700 tracking-wide shrink-0">직전 분기 수</span>
                    <div className="bg-slate-100/60 h-9 px-3 rounded-xl flex items-center gap-3 border border-slate-100">
                      <button 
                        onClick={() => setQuartersCount(prev => Math.max(1, prev - 1))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-200/50 rounded-lg transition-colors text-sm font-bold cursor-pointer"
                      >
                        -
                      </button>
                      <span className="font-extrabold text-slate-800 text-xs w-4 text-center">{quartersCount}</span>
                      <button 
                        onClick={() => setQuartersCount(prev => Math.min(20, prev + 1))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-200/50 rounded-lg transition-colors text-sm font-bold cursor-pointer"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-400 font-medium">영업이익률(%) 조건을 동시에 지정하여 원하는 범위 내의 상장기업만 필터링합니다.</span>
                </div>

                {/* Bottom Row: 최소 / 최대 / 평균 한 줄 배치 */}
                <div className="flex flex-row flex-wrap items-center justify-center gap-x-6 gap-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-100/80">
                  {/* 최소 영업이익률 */}
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-xs font-black text-slate-700 select-none shrink-0">
                      <input 
                        type="checkbox" 
                        checked={applyMin} 
                        onChange={(e) => setApplyMin(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 accent-blue-600 cursor-pointer"
                      />
                      최소 적용
                    </label>
                    <div className="flex items-center bg-white h-9 px-2 rounded-xl border border-slate-200 shadow-sm">
                      <input 
                        type="number"
                        step="0.5"
                        value={minMargin}
                        onChange={(e) => setMinMargin(parseFloat(e.target.value) || 0)}
                        className="bg-transparent border-none outline-none focus:ring-0 w-11 font-bold text-slate-800 text-xs text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-xs text-slate-400 font-bold mr-1">%</span>
                      <button 
                        onClick={() => setMinMargin(prev => Math.max(0, Number((prev - 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        -
                      </button>
                      <button 
                        onClick={() => setMinMargin(prev => Math.min(100, Number((prev + 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="hidden sm:block w-px h-5 bg-slate-200" />

                  {/* 최대 영업이익률 */}
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-xs font-black text-slate-700 select-none shrink-0">
                      <input 
                        type="checkbox" 
                        checked={applyMax} 
                        onChange={(e) => setApplyMax(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 accent-blue-600 cursor-pointer"
                      />
                      최대 적용
                    </label>
                    <div className="flex items-center bg-white h-9 px-2 rounded-xl border border-slate-200 shadow-sm">
                      <input 
                        type="number"
                        step="0.5"
                        value={maxMargin}
                        onChange={(e) => setMaxMargin(parseFloat(e.target.value) || 0)}
                        className="bg-transparent border-none outline-none focus:ring-0 w-11 font-bold text-slate-800 text-xs text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-xs text-slate-400 font-bold mr-1">%</span>
                      <button 
                        onClick={() => setMaxMargin(prev => Math.max(0, Number((prev - 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        -
                      </button>
                      <button 
                        onClick={() => setMaxMargin(prev => Math.min(100, Number((prev + 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="hidden sm:block w-px h-5 bg-slate-200" />

                  {/* 평균 영업이익률 */}
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-xs font-black text-slate-700 select-none shrink-0">
                      <input 
                        type="checkbox" 
                        checked={applyAvg} 
                        onChange={(e) => setApplyAvg(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 accent-blue-600 cursor-pointer"
                      />
                      평균 적용
                    </label>
                    <div className="flex items-center bg-white h-9 px-2 rounded-xl border border-slate-200 shadow-sm">
                      <input 
                        type="number"
                        step="0.5"
                        value={avgMargin}
                        onChange={(e) => setAvgMargin(parseFloat(e.target.value) || 0)}
                        className="bg-transparent border-none outline-none focus:ring-0 w-11 font-bold text-slate-800 text-xs text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-xs text-slate-400 font-bold mr-1">%</span>
                      <button 
                        onClick={() => setAvgMargin(prev => Math.max(0, Number((prev - 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        -
                      </button>
                      <button 
                        onClick={() => setAvgMargin(prev => Math.min(100, Number((prev + 0.5).toFixed(2))))}
                        className="w-6 h-6 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md text-xs font-bold cursor-pointer"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Extract List Button */}
                <button 
                  onClick={handleConditionalSearch}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold h-11 rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 text-sm cursor-pointer active:scale-[0.99]"
                >
                  리스트 추출
                </button>
              </div>
            </div>

            {/* Conditional Results Display */}
            {conditionalLoading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <Loader2 className="animate-spin text-blue-600" size={48} />
                <p className="text-slate-500 text-sm animate-pulse font-medium">상장사 재무 데이터를 스캐닝 및 분석 중입니다...</p>
              </div>
            ) : conditionalError ? (
              <div className="bg-red-50 border border-red-100 rounded-2xl p-8 text-center max-w-lg mx-auto">
                <AlertCircle className="mx-auto text-red-400 mb-3" size={32} />
                <p className="text-red-800 font-semibold mb-1">{conditionalError}</p>
                <p className="text-red-600/60 text-sm">다시 시도해주세요.</p>
              </div>
            ) : conditionalResults.length > 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200/60 max-w-4xl mx-auto overflow-hidden animate-in fade-in"
              >
                {/* Redesigned Header & Filter Bar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-5 mb-6">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-extrabold text-slate-900 text-lg tracking-tight">
                        발굴된 기업 목록
                      </h3>
                      <span className="text-xs font-black bg-blue-50 text-blue-600 px-2.5 py-0.5 rounded-full">
                        {sortedAndFilteredResults.length}개 기업
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 font-medium">컬럼 헤더를 클릭하여 정렬하거나 열 필터를 켜서 정밀 탐색하세요.</p>
                  </div>
                  
                  <div className="flex items-center gap-2 self-end sm:self-center">
                    {/* Column Filters Toggle Button */}
                    <button
                      onClick={() => setShowColumnFilters(!showColumnFilters)}
                      className={cn(
                        "h-9 px-3 border rounded-xl flex items-center gap-1.5 text-xs font-semibold cursor-pointer transition-all",
                        showColumnFilters 
                          ? "bg-blue-50 border-blue-200 text-blue-600" 
                          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <SlidersHorizontal size={13} />
                      <span>열 필터 {showColumnFilters ? "닫기" : "켜기"}</span>
                    </button>

                    {/* Local Filter Input */}
                    <div className="relative w-full sm:w-60">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                        <Search size={14} />
                      </div>
                      <input
                        type="text"
                        placeholder="결과 내 검색 (기업명/종목코드)"
                        className="w-full h-9 pl-9 pr-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/10 focus:border-blue-600 transition-all text-xs font-semibold placeholder-slate-400"
                        value={localFilter}
                        onChange={(e) => setLocalFilter(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {sortedAndFilteredResults.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-[10px] font-black text-slate-400 uppercase tracking-wider border-b border-slate-100 bg-slate-50/50">
                          <th 
                            onClick={() => handleSort('corp_name')}
                            className="py-3 px-4 text-left rounded-l-xl cursor-pointer hover:bg-slate-100/50 transition-colors select-none"
                          >
                            <div className="flex items-center gap-1.5 justify-start">
                              <span>기업 정보</span>
                              <ArrowUpDown size={12} className={cn("transition-opacity", sortField === 'corp_name' ? "text-blue-500 opacity-100" : "text-slate-300 opacity-40")} />
                            </div>
                          </th>
                          <th 
                            onClick={() => handleSort('avgMargin')}
                            className="py-3 px-4 text-right cursor-pointer hover:bg-slate-100/50 transition-colors select-none"
                          >
                            <div className="flex items-center gap-1.5 justify-end">
                              <span>평균 영업이익률</span>
                              <ArrowUpDown size={12} className={cn("transition-opacity", sortField === 'avgMargin' ? "text-blue-500 opacity-100" : "text-slate-300 opacity-40")} />
                            </div>
                          </th>
                          <th 
                            onClick={() => handleSort('minMargin')}
                            className="py-3 px-4 text-right cursor-pointer hover:bg-slate-100/50 transition-colors select-none"
                          >
                            <div className="flex items-center gap-1.5 justify-end">
                              <span>최소 영업이익률</span>
                              <ArrowUpDown size={12} className={cn("transition-opacity", sortField === 'minMargin' ? "text-blue-500 opacity-100" : "text-slate-300 opacity-40")} />
                            </div>
                          </th>
                          <th 
                            onClick={() => handleSort('maxMargin')}
                            className="py-3 px-4 text-right cursor-pointer hover:bg-slate-100/50 transition-colors select-none"
                          >
                            <div className="flex items-center gap-1.5 justify-end">
                              <span>최대 영업이익률</span>
                              <ArrowUpDown size={12} className={cn("transition-opacity", sortField === 'maxMargin' ? "text-blue-500 opacity-100" : "text-slate-300 opacity-40")} />
                            </div>
                          </th>
                          {conditionalQuarters.map((q, idx) => (
                            <th 
                              key={idx} 
                              onClick={() => handleSort(`quarter_${idx}`)}
                              className="py-3 px-4 text-right cursor-pointer hover:bg-slate-100/50 transition-colors select-none"
                            >
                              <div className="flex items-center gap-1.5 justify-end">
                                <span>{q}</span>
                                <ArrowUpDown size={12} className={cn("transition-opacity", sortField === `quarter_${idx}` ? "text-blue-500 opacity-100" : "text-slate-300 opacity-40")} />
                              </div>
                            </th>
                          ))}
                          <th className="py-3 px-4 text-right rounded-r-xl w-24 select-none">상세분석</th>
                        </tr>
                        {showColumnFilters && (
                          <tr className="bg-slate-50/80 border-b border-slate-100 animate-in slide-in-from-top duration-200">
                            {/* 기업 정보 필터 */}
                            <td className="py-2 px-3">
                              <input
                                type="text"
                                placeholder="기업명/코드 필터"
                                className="w-full h-8 px-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                value={colFilters.corp}
                                onChange={(e) => setColFilters(prev => ({ ...prev, corp: e.target.value }))}
                              />
                            </td>
                            {/* 평균 영업이익률 필터 */}
                            <td className="py-2 px-3">
                              <div className="flex items-center gap-1 justify-end">
                                <input
                                  type="number"
                                  placeholder="이상"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.avgMin}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, avgMin: e.target.value }))}
                                />
                                <span className="text-[9px] text-slate-400">~</span>
                                <input
                                  type="number"
                                  placeholder="이하"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.avgMax}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, avgMax: e.target.value }))}
                                />
                                <span className="text-[10px] text-slate-400 font-bold">%</span>
                              </div>
                            </td>
                            {/* 최소 영업이익률 필터 */}
                            <td className="py-2 px-3">
                              <div className="flex items-center gap-1 justify-end">
                                <input
                                  type="number"
                                  placeholder="이상"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.minMin}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, minMin: e.target.value }))}
                                />
                                <span className="text-[9px] text-slate-400">~</span>
                                <input
                                  type="number"
                                  placeholder="이하"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.minMax}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, minMax: e.target.value }))}
                                />
                                <span className="text-[10px] text-slate-400 font-bold">%</span>
                              </div>
                            </td>
                            {/* 최대 영업이익률 필터 */}
                            <td className="py-2 px-3">
                              <div className="flex items-center gap-1 justify-end">
                                <input
                                  type="number"
                                  placeholder="이상"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.maxMin}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, maxMin: e.target.value }))}
                                />
                                <span className="text-[9px] text-slate-400">~</span>
                                <input
                                  type="number"
                                  placeholder="이하"
                                  className="w-12 h-8 px-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                  value={colFilters.maxMax}
                                  onChange={(e) => setColFilters(prev => ({ ...prev, maxMax: e.target.value }))}
                                />
                                <span className="text-[10px] text-slate-400 font-bold">%</span>
                              </div>
                            </td>
                            {/* 분기들 빈 칸 */}
                            {conditionalQuarters.map((_, idx) => (
                              <td key={idx} className="py-2 px-3"></td>
                            ))}
                            {/* 상세분석 빈 칸 및 초기화 */}
                            <td className="py-2 px-3 text-right">
                              <button
                                onClick={() => setColFilters({
                                  corp: '',
                                  avgMin: '',
                                  avgMax: '',
                                  minMin: '',
                                  minMax: '',
                                  maxMin: '',
                                  maxMax: '',
                                })}
                                className="text-[10px] font-bold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer"
                              >
                                초기화
                              </button>
                            </td>
                          </tr>
                        )}
                      </thead>
                      <tbody className="text-xs divide-y divide-slate-150">
                        {sortedAndFilteredResults.map((row, idx) => {
                          const isHighAvg = row.avgMargin >= 15;
                          const isNegativeMin = row.minMargin < 0;
                          const isHighMax = row.maxMargin >= 50;
                          return (
                            <tr 
                              key={idx} 
                              className="group hover:bg-slate-50/60 transition-colors cursor-pointer"
                              onClick={() => {
                                setActiveTab('individual');
                                fetchFinancials({
                                  corp_code: row.corp_code,
                                  corp_name: row.corp_name,
                                  stock_code: row.stock_code
                                });
                              }}
                            >
                              <td className="py-4 px-4 font-bold text-slate-900 uppercase">
                                <div className="flex flex-col">
                                  <span className="text-slate-900 font-bold text-sm group-hover:text-blue-600 transition-colors">
                                    {row.corp_name}
                                  </span>
                                  <span className="text-[10px] text-slate-400 font-mono mt-0.5 font-normal">
                                    {row.stock_code}
                                  </span>
                                </div>
                              </td>
                              <td className="py-4 px-4 text-right">
                                <span className={cn(
                                  "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-black",
                                  isHighAvg 
                                    ? "bg-emerald-50 text-emerald-700" 
                                    : row.avgMargin > 0 
                                      ? "bg-blue-50 text-blue-700" 
                                      : "bg-rose-50 text-rose-700"
                                )}>
                                  {row.avgMargin.toFixed(2)}%
                                </span>
                              </td>
                              <td className="py-4 px-4 text-right">
                                <span className={cn(
                                  "inline-block px-2 py-0.5 rounded text-xs font-semibold",
                                  isNegativeMin 
                                    ? "bg-rose-50/50 text-rose-600" 
                                    : "bg-slate-100 text-slate-600"
                                )}>
                                  {row.minMargin.toFixed(2)}%
                                </span>
                              </td>
                              <td className="py-4 px-4 text-right">
                                <span className={cn(
                                  "inline-block px-2 py-0.5 rounded text-xs font-semibold",
                                  isHighMax 
                                    ? "bg-amber-50 text-amber-600" 
                                    : "bg-slate-100 text-slate-600"
                                )}>
                                  {row.maxMargin !== undefined ? `${row.maxMargin.toFixed(2)}%` : '-'}
                                </span>
                              </td>
                              {row.margins.map((m: number, qIdx: number) => {
                                const isHigh = m >= 15;
                                const isNeg = m < 0;
                                return (
                                  <td key={qIdx} className="py-4 px-4 text-right font-semibold text-slate-500 font-mono">
                                    <span className={cn(
                                      "text-xs font-bold font-mono",
                                      isHigh 
                                        ? "text-emerald-600" 
                                        : isNeg 
                                          ? "text-rose-500" 
                                          : "text-slate-500"
                                    )}>
                                      {m.toFixed(2)}%
                                    </span>
                                  </td>
                                );
                              })}
                              <td className="py-4 px-4 text-right">
                                <div className="flex items-center justify-end text-xs font-bold text-slate-300 group-hover:text-blue-600 transition-all">
                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity mr-1 text-[11px] font-medium hidden sm:inline">분석</span>
                                  <ArrowUpRight size={14} className="transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="py-16 text-center">
                    <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-4 text-slate-300">
                      <Search size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-800 mb-1">검색 결과가 없습니다</p>
                    <p className="text-xs text-slate-400 max-w-xs mx-auto">입력하신 "{localFilter}"에 매칭되는 발굴 기업이 없습니다. 다른 키워드를 입력해 보세요.</p>
                  </div>
                )}
              </motion.div>
            ) : (
              <div className="py-24 text-center">
                <div className="w-20 h-20 bg-slate-100 rounded-3xl flex items-center justify-center mx-auto mb-6 text-slate-300">
                  <Search size={32} />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-1">조건 검색 결과 없음</h3>
                <p className="text-slate-400 max-w-xs mx-auto">상단 필터를 조정하고 '리스트 추출'을 누르면 조건에 부합하는 상장사 목록이 이곳에 노출됩니다.</p>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-12 border-t border-slate-200 mt-12 flex flex-col md:flex-row items-center justify-between gap-4 text-slate-400 text-xs">
        <p>© 2026 DART FINANCIAL ANALYSIS. Powered by Open DART API.</p>
        <div className="flex gap-6">
          <a href="#" className="hover:text-blue-600 transition-colors">Documentation</a>
          <a href="#" className="hover:text-blue-600 transition-colors">Privacy Policy</a>
          <a href="#" className="hover:text-blue-600 transition-colors">Terms of Service</a>
        </div>
      </footer>
    </div>
  );
}

function StatCard({ title, value, icon, color }: { title: string, value: string, icon: ReactNode, color: 'blue' | 'green' | 'slate' }) {
  const colors = {
    blue: "text-blue-600 bg-blue-50 border-blue-100",
    green: "text-green-600 bg-green-50 border-green-100",
    slate: "text-slate-600 bg-slate-50 border-slate-100"
  };

  return (
    <div className="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm">
      <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center mb-4 border", colors[color])}>
        {icon}
      </div>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-tight mb-1">{title}</p>
      <p className="text-xl font-black text-slate-900">{value}</p>
    </div>
  );
}
