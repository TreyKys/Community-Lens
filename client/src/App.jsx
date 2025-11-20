import React, { useState } from 'react';
import axios from 'axios';
import { ShieldAlert, ShieldCheck, Scan, Database, Terminal, ExternalLink, Copy } from 'lucide-react';

function App() {
  const [claim, setClaim] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [publishedAsset, setPublishedAsset] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const handleAnalyze = async () => {
    if (!claim.trim()) return;
    setAnalyzing(true);
    setResult(null);
    setPublishedAsset(null);
    setError(null);

    try {
      const response = await axios.post('http://localhost:4000/api/analyze', { claim });
      setResult(response.data);
    } catch (err) {
      console.error(err);
      setError("Failed to analyze claim. Please check server connection.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handlePublish = async () => {
    if (!result || !claim) return;
    setPublishing(true);
    try {
      const payload = {
        claim,
        verdict: result.isTrue ? "VERIFIED" : "DEBUNKED",
        evidence: result.evidence,
        metadata: {
          confidence: result.confidence,
          analysis: result.analysis,
          timestamp: new Date().toISOString()
        }
      };

      const response = await axios.post('http://localhost:4000/api/publish', payload);

      const newAsset = {
        ...response.data,
        claim: claim.substring(0, 50) + (claim.length > 50 ? "..." : ""),
        timestamp: new Date().toLocaleTimeString()
      };

      setPublishedAsset(response.data);
      setHistory(prev => [newAsset, ...prev]);
    } catch (err) {
      console.error(err);
      setError("Failed to publish truth patch.");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-5xl mx-auto">
      {/* Hero */}
      <header className="mb-10 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-cyan-400 tracking-tight mb-2">
          Community Lens Protocol
        </h1>
        <p className="text-slate-400 text-lg">
          Cognitive Firewall & Truth Verification Engine
        </p>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Input & Action */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-slate-800 p-6 rounded-lg shadow-lg border border-slate-700">
            <label className="block text-cyan-500 font-mono mb-2 flex items-center gap-2">
              <Scan size={18} />
              INPUT_STREAM // Suspicious AI Output / Claim
            </label>
            <textarea
              className="w-full h-32 bg-slate-900 border border-slate-700 rounded p-3 focus:outline-none focus:border-cyan-500 transition-colors text-slate-200 resize-none"
              placeholder="Paste text here for verification..."
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={handleAnalyze}
                disabled={analyzing || !claim.trim()}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                {analyzing ? (
                  <>
                    <Scan className="animate-spin" size={20} /> Scanning...
                  </>
                ) : (
                  <>
                    <Scan size={20} /> Scan & Verify
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Results Area */}
          {error && (
            <div className="bg-red-900/20 border border-red-500/50 p-4 rounded text-red-300">
              {error}
            </div>
          )}

          {result && (
            <div className="bg-slate-800 p-6 rounded-lg shadow-lg border border-slate-700 animate-fade-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  ANALYSIS_RESULT
                </h2>
                <span className={`px-3 py-1 rounded text-sm font-bold ${result.isTrue ? 'bg-green-900/50 text-green-400 border border-green-600' : 'bg-red-900/50 text-red-400 border border-red-600'}`}>
                  CONFIDENCE: {result.confidence}%
                </span>
              </div>

              <div className="flex flex-col md:flex-row gap-6 items-start">
                <div className="flex-shrink-0">
                  {result.isTrue ? (
                    <ShieldCheck size={80} className="text-green-500" />
                  ) : (
                    <ShieldAlert size={80} className="text-red-500" />
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  <div className="bg-slate-900/50 p-3 rounded border border-slate-700/50">
                    <span className="text-slate-500 text-xs uppercase block mb-1">Verdict</span>
                    <p className={`text-lg font-bold ${result.isTrue ? 'text-green-400' : 'text-red-400'}`}>
                      {result.isTrue ? "VERIFIED AUTHENTIC" : "POTENTIALLY FALSE / DEBUNKED"}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-500 text-xs uppercase block mb-1">Analysis</span>
                    <p className="text-slate-300 leading-relaxed">
                      {result.analysis}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-500 text-xs uppercase block mb-1">Evidence</span>
                    <p className="text-cyan-400/80 font-mono text-sm">
                      {result.evidence}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-6 border-t border-slate-700 flex justify-end">
                <button
                  onClick={handlePublish}
                  disabled={publishing || publishedAsset}
                  className="btn-secondary flex items-center gap-2"
                >
                   {publishing ? (
                     <>Minting...</>
                   ) : publishedAsset ? (
                     <>Minted</>
                   ) : (
                     <>
                      <Database size={18} /> Mint Truth Patch (DKG)
                     </>
                   )}
                </button>
              </div>
            </div>
          )}

          {/* Published Asset UAL */}
          {publishedAsset && (
            <div className="bg-slate-900 p-4 rounded border border-cyan-900/50 mt-4">
              <div className="flex items-center justify-between mb-2">
                 <span className="text-cyan-500 font-mono text-sm flex items-center gap-2">
                   <Terminal size={14} /> ASSET_MINTED_ON_DKG
                 </span>
                 {publishedAsset.status === 'simulated_gas_error' && (
                   <span className="text-yellow-500 text-xs">SIMULATED (NO GAS/CREDENTIALS)</span>
                 )}
              </div>
              <div className="terminal-box break-all text-xs text-slate-400 flex justify-between items-center">
                <span>{publishedAsset.ual}</span>
                <button className="ml-2 text-slate-500 hover:text-white" title="Copy UAL">
                  <Copy size={14} />
                </button>
              </div>
              <div className="mt-2 text-right">
                 <a href="#" className="text-xs text-cyan-600 hover:text-cyan-400 flex items-center justify-end gap-1">
                   View on DKG Explorer <ExternalLink size={12} />
                 </a>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: History */}
        <div className="space-y-4">
          <div className="bg-slate-800 p-4 rounded-lg shadow-lg border border-slate-700 h-full">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Database size={18} className="text-cyan-500" />
              Session History
            </h3>
            <div className="space-y-3">
              {history.length === 0 && (
                <p className="text-slate-500 text-sm italic">No assets published this session.</p>
              )}
              {history.map((item, idx) => (
                <div key={idx} className="bg-slate-900 p-3 rounded border border-slate-700 text-sm">
                   <div className="flex justify-between items-start mb-1">
                     <span className="text-xs text-slate-500">{item.timestamp}</span>
                     {item.status === 'simulated_gas_error' ? (
                       <span className="text-[10px] text-yellow-600 border border-yellow-800 px-1 rounded">SIM</span>
                     ) : (
                       <span className="text-[10px] text-green-600 border border-green-800 px-1 rounded">NET</span>
                     )}
                   </div>
                   <p className="text-slate-300 mb-2 truncate" title={item.claim}>{item.claim}</p>
                   <div className="font-mono text-[10px] text-slate-500 truncate">
                     {item.ual}
                   </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
