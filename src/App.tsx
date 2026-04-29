import { useState, useEffect, type ReactNode } from 'react';
import axios from 'axios';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, 
  ResponsiveContainer, LineChart, Line, ComposedChart, Cell
} from 'recharts';
import { Search, TrendingUp, Calendar, Building2, Loader2, AlertCircle, ArrowUpRight, BarChart3, List } from 'lucide-react';
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
  const [searchTerm, setSearchTerm] = useState('');
  const [baseDate, setBaseDate] = useState('202512');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCorp, setSelectedCorp] = useState<Company | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [financials, setFinancials] = useState<FinancialData[]>([]);
  const [error, setError] = useState<string | null>(null);

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
                        className="w-full text-left px-5 py-4 hover:bg-slate-50 flex items-center justify-between group transition-colors border-b border-slate-50 last:border-0"
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
                className="w-full h-10 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
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
        ) : financials.length > 0 && selectedCorp && (
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
                <div className="flex items-center justify-between mb-8">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2">
                    <BarChart3 size={18} className="text-blue-500" />
                    실적 추이 보고서
                  </h4>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                      <div className="w-2 h-2 rounded-full bg-slate-200" /> 매출액
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                      <div className="w-2 h-2 rounded-full bg-green-500" /> 영업이익
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-600">
                      <div className="w-2 h-2 rounded-full bg-blue-600" /> 영업이익률
                    </div>
                  </div>
                </div>
                <div className="h-[400px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={financials} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
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
                        <th className="pb-3 text-right">매출액</th>
                        <th className="pb-3 text-right">영업이익</th>
                        <th className="pb-3 text-right">이익률</th>
                        <th className="pb-3 text-right">Source</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs">
                      {[...financials].reverse().map((row, idx) => (
                        <tr key={idx} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                          <td className="py-3 font-semibold text-slate-600">{row.기간}</td>
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
                title="평균 영업이익률" 
                value={`${(financials.reduce((acc, curr) => acc + curr.영업이익률, 0) / financials.length).toFixed(2)}%`}
                icon={<TrendingUp size={20} />}
                color="blue"
              />
              <StatCard 
                title="최대 분기 매출" 
                value={`${Math.max(...financials.map(f => f.매출액)).toLocaleString()}M`}
                icon={<BarChart3 size={20} />}
                color="slate"
              />
              <StatCard 
                title="분기 최고 이익률" 
                value={`${Math.max(...financials.map(f => f.영업이익률)).toFixed(2)}%`}
                icon={<TrendingUp size={20} />}
                color="green"
              />
              <StatCard 
                title="분석 대상 분기" 
                value={`${financials.length} Quarters`}
                icon={<Calendar size={20} />}
                color="slate"
              />
            </div>
          </motion.div>
        )}

        {/* Empty State */}
        {!selectedCorp && !loading && !error && (
          <div className="py-24 text-center">
            <div className="w-20 h-20 bg-slate-100 rounded-3xl flex items-center justify-center mx-auto mb-6 text-slate-300">
              <Search size={32} />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-1">Company Search</h3>
            <p className="text-slate-400 max-w-xs mx-auto">분석하고 싶은 기업의 이름을 상단 검색창에 입력하여 분석을 시작하세요.</p>
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
