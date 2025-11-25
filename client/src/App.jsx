import React, { useState, useEffect } from 'react';
import { Search, TriangleAlert, CheckCircle, Copy, Shield, Share2, MessageSquare } from 'lucide-react';
import axios from 'axios';
import clsx from 'clsx';
import { motion } from 'framer-motion';

// UPDATE: Point to Render Backend
const API_URL = 'https://community-lens-ot88.onrender.com';

function App() {
  const [activeTab, setActiveTab] = useState('verifier'); // 'verifier' | 'agent'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-900">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 sticky top-0 z-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-cyan-500/10 p-2 rounded-lg border border-cyan-500/30">
            <Shield className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              Community Lens <span className="text-cyan-500">Protocol</span>
            </h1>
            <div className="flex gap-2 text-xs mt-1">
              <span className="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">Mainnet Beta</span>
              <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded border border-blue-500/30">DKG Connected</span>
            </div>
          </div>
        </div>

        <nav className="flex bg-slate-900 rounded-lg p-1 border border-slate-800">
          <button
            onClick={() => setActiveTab('verifier')}
            className={clsx(
              "px-4 py-2 text-sm font-medium rounded-md transition-all",
              activeTab === 'verifier' ? "bg-slate-800 text-cyan-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
            )}
          >
            Verifier Console
          </button>
          <button
             onClick={() => setActiveTab('agent')}
             className={clsx(
              "px-4 py-2 text-sm font-medium rounded-md transition-all",
              activeTab === 'agent' ? "bg-slate-800 text-cyan-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
            )}
          >
            Agent Guard
          </button>
        </nav>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {activeTab === 'verifier' ? <VerifierView /> : <AgentView />}
      </main>
    </div>
  );
}

function VerifierView() {
  const [caseStudies, setCaseStudies] = useState([]);
  const [topicInput, setTopicInput] = useState('');
  const [grokText, setGrokText] = useState('');
  const [wikiText, setWikiText] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [publishStatus, setPublishStatus] = useState(null); // null, 'publishing', 'success', 'error'
  const [stakeAmount, setStakeAmount] = useState(500);
  const [publishedUAL, setPublishedUAL] = useState('');

  useEffect(() => {
    // Load case studies on mount to populate dropdown
    axios.get(`${API_URL}/api/cases`)
      .then(res => setCaseStudies(res.data))
      .catch(err => console.error("Failed to load cases", err));
  }, []);

  const handleFetchDual = async () => {
    if (!topicInput) return;
    setLoading(true);
    setAnalysis(null); // Clear previous analysis
    setPublishStatus(null);
    setPublishedUAL('');

    try {
        const res = await axios.post(`${API_URL}/api/fetch-dual`, { topic: topicInput });
        setGrokText(res.data.grokText);
        setWikiText(res.data.wikiText);
    } catch (err) {
        console.error(err);
        alert("Failed to fetch sources.");
    } finally {
        setLoading(false);
    }
  };

  const handleDropdownChange = (e) => {
      const selectedId = e.target.value;
      if (!selectedId) return;

      const study = caseStudies.find(c => c.id === selectedId);
      if (study) {
          setTopicInput(study.topic);
          // If the user selects a seed, we can either auto-fetch or let them click fetch.
          // Let's auto-fill and let them click fetch to simulate the "Search" experience,
          // OR pre-fill the text if we want the instant demo experience.
          // The prompt says: "When user types a topic and clicks 'Fetch', call /api/fetch-dual."
          // But for dropdown, it says "Populate the list".
          // Let's just fill the input and trigger fetch automatically for convenience?
          // Or just fill input. Let's just fill input.
          // actually, the demo might expect the text to appear.
          // Let's call fetchDual immediately if they select from dropdown.

          // Re-implementing logic to support both manual type and dropdown select
          // But I can't call handleFetchDual directly easily due to closure state (topicInput),
          // so I'll set input and then call the API with the value directly.

          setTopicInput(study.topic);

          // Trigger fetch immediately
          setLoading(true);
          setAnalysis(null);
          setPublishStatus(null);
          setPublishedUAL('');

          axios.post(`${API_URL}/api/fetch-dual`, { topic: study.topic })
            .then(res => {
                setGrokText(res.data.grokText);
                setWikiText(res.data.wikiText);
            })
            .catch(err => {
                 console.error(err);
                 // If real fetch fails for seed data, maybe fallback to local?
                 // But backend handles seed data logic if needed usually.
                 // For now, assume backend works.
                 if (study.grokText && study.wikiText) {
                     setGrokText(study.grokText);
                     setWikiText(study.wikiText);
                 }
            })
            .finally(() => setLoading(false));
      }
  };

  const runAnalysis = async () => {
    if (!grokText || !wikiText) return;
    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/api/analyze`, {
        grokText,
        wikiText,
        // topic: topicInput // backend doesn't technically need topic for comparison, but good for logging
      });
      setAnalysis(res.data);
    } catch (err) {
      console.error(err);
      alert("Analysis failed.");
    } finally {
      setLoading(false);
    }
  };

  const publishPatch = async () => {
    if (!analysis) return;
    setPublishStatus('publishing');
    try {
        const res = await axios.post(`${API_URL}/api/publish`, {
            claim: {
                topic: topicInput,
                grokText
            },
            analysis,
            stakeAmount
        });
        if (res.data.status === 'success') {
            setPublishStatus('success');
            setPublishedUAL(res.data.ual);
        } else {
            setPublishStatus('error');
        }
    } catch (err) {
        console.error(err);
        setPublishStatus('error');
    }
  };

  const highlightText = (text, flags) => {
    if (!flags || flags.length === 0) return text;
    let html = text;
    flags.forEach(flag => {
        // Basic safety for regex
        if (!flag.quote && !flag.text) return;
        const txt = flag.quote || flag.text; // Support both formats
        const safeText = txt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Limit length to avoid massive regex performance hits on long texts if needed
        const regex = new RegExp(`(${safeText})`, 'gi');
        const colorClass = flag.type.toLowerCase().includes('hallucination') ? 'bg-red-500/30 text-red-200 border-b-2 border-red-500' : 'bg-yellow-500/30 text-yellow-200 border-b-2 border-yellow-500';
        html = html.replace(regex, `<span class="${colorClass} px-1 rounded relative group cursor-help" title="${flag.explanation || ''}">$1</span>`);
    });
    return <div dangerouslySetInnerHTML={{ __html: html }} className="whitespace-pre-wrap" />;
  };

  return (
    <div className="space-y-6">
        {/* Top Action Bar */}
        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex flex-col md:flex-row items-center justify-between gap-4 shadow-lg">
            {/* Search / Input */}
            <div className="flex-1 w-full flex items-center gap-2">
                <input
                    type="text"
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    placeholder="Enter a topic to investigate..."
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                />
                <button
                    onClick={handleFetchDual}
                    disabled={loading || !topicInput}
                    className="bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                    <Search size={18} />
                    Fetch
                </button>
            </div>

            {/* Dropdown */}
            <div className="flex items-center gap-2 w-full md:w-auto">
                <span className="text-slate-400 text-sm font-medium whitespace-nowrap hidden lg:block">Curious? Here are some sample topics:</span>
                <select
                    className="flex-1 md:w-64 bg-slate-800 border border-slate-700 text-white text-sm rounded-lg focus:ring-cyan-500 focus:border-cyan-500 block p-2.5"
                    onChange={handleDropdownChange}
                    defaultValue=""
                >
                    <option value="" disabled>-- Select Topic --</option>
                    {caseStudies.map(c => (
                        <option key={c.id} value={c.id}>{c.topic}</option>
                    ))}
                </select>
            </div>
        </div>

        {/* Comparator */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Suspect Source */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden flex flex-col h-[400px]">
                <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <h3 className="font-semibold text-red-400 flex items-center gap-2">
                        <TriangleAlert size={16} />
                        Suspect Source (Grokipedia)
                    </h3>
                </div>
                <div className="flex-1 p-4 bg-slate-900/50 relative overflow-y-auto">
                    {loading && !grokText ? (
                        <div className="flex items-center justify-center h-full text-slate-500 animate-pulse">Querying Grokipedia...</div>
                    ) : (
                         analysis ? (
                            <div className="text-sm leading-relaxed text-slate-300">
                                {highlightText(grokText, analysis.flags)}
                            </div>
                        ) : (
                             <textarea
                                className="w-full h-full bg-transparent resize-none focus:outline-none text-slate-300 text-sm leading-relaxed p-1"
                                placeholder="Grok output will appear here..."
                                value={grokText}
                                readOnly
                            />
                        )
                    )}
                </div>
            </div>

            {/* Trusted Source */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden flex flex-col h-[400px]">
                <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <h3 className="font-semibold text-emerald-400 flex items-center gap-2">
                        <CheckCircle size={16} />
                        Trusted Consensus (Wikipedia)
                    </h3>
                </div>
                <div className="flex-1 p-4 bg-slate-900/50 overflow-y-auto">
                    {loading && !wikiText ? (
                        <div className="flex items-center justify-center h-full text-slate-500 animate-pulse">Fetching Consensus...</div>
                    ) : (
                         <textarea
                            className="w-full h-full bg-transparent resize-none focus:outline-none text-slate-300 text-sm leading-relaxed p-1"
                            placeholder="Wikipedia content will appear here..."
                            value={wikiText}
                            readOnly
                        />
                    )}
                </div>
            </div>
        </div>

        {/* Analysis Engine */}
        <div className="flex justify-center">
            <button
                onClick={runAnalysis}
                disabled={loading || !grokText || !wikiText}
                className={clsx(
                    "px-8 py-4 rounded-full font-bold text-lg tracking-wide shadow-lg shadow-cyan-500/20 transition-all transform hover:scale-105 active:scale-95 flex items-center gap-3",
                    loading ? "bg-slate-700 text-slate-400 cursor-not-allowed" : "bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:shadow-cyan-500/40"
                )}
            >
                {loading ? "Analyzing..." : "RUN DISCREPANCY CHECK"}
            </button>
        </div>

        {/* Results & Trust Layer */}
        {analysis && (
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl"
            >
                <div className="flex flex-col md:flex-row gap-8">
                    {/* Score */}
                    <div className="flex-shrink-0 text-center md:text-left">
                        <div className="text-sm text-slate-400 uppercase tracking-widest mb-2">Alignment Score</div>
                        <div className={clsx(
                            "text-6xl font-black",
                            analysis.alignmentScore > 80 ? "text-emerald-400" : analysis.alignmentScore < 50 ? "text-red-500" : "text-yellow-400"
                        )}>
                            {analysis.alignmentScore}%
                        </div>
                        <div className="text-sm mt-2 text-slate-500">
                            {analysis.flags ? analysis.flags.length : 0} Discrepancies Found
                        </div>
                    </div>

                    {/* Flags List */}
                    <div className="flex-1 space-y-3">
                        <h4 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Detected Issues</h4>
                        {(!analysis.flags || analysis.flags.length === 0) ? (
                            <div className="text-emerald-500 italic">No significant discrepancies found. Content appears accurate.</div>
                        ) : (
                            analysis.flags.map((flag, idx) => (
                                <div key={idx} className="bg-slate-800/50 border border-slate-700 rounded p-3 text-sm">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={clsx(
                                            "px-2 py-0.5 text-[10px] font-bold uppercase rounded",
                                            flag.type.toLowerCase().includes('hallucination') ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"
                                        )}>
                                            {flag.type}
                                        </span>
                                    </div>
                                    <div className="text-slate-300 mb-1">"<span className="italic">{flag.quote || flag.text}</span>"</div>
                                    <div className="text-slate-500 text-xs">{flag.explanation}</div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Staking & Publishing */}
                <div className="mt-8 pt-6 border-t border-slate-800">
                    <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                        <div className="w-full md:w-1/2">
                            <label className="block text-sm font-medium text-slate-400 mb-2">
                                Stake Reputation (TRAC)
                            </label>
                            <input
                                type="range"
                                min="10"
                                max="1000"
                                value={stakeAmount}
                                onChange={(e) => setStakeAmount(e.target.value)}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            />
                            <div className="flex justify-between text-xs text-slate-500 mt-1">
                                <span>10 TRAC</span>
                                <span className="text-cyan-400 font-bold">{stakeAmount} TRAC (${(stakeAmount * 0.5).toFixed(2)})</span>
                                <span>1000 TRAC</span>
                            </div>
                        </div>

                        <div className="w-full md:w-auto flex-shrink-0">
                            {publishStatus === 'success' ? (
                                <div className="bg-emerald-900/20 border border-emerald-500/50 rounded-lg p-4 max-w-md break-all">
                                    <div className="flex items-center gap-2 text-emerald-400 font-bold mb-2">
                                        <CheckCircle size={18} />
                                        Truth Patch Minted
                                    </div>
                                    <div className="text-[10px] font-mono text-emerald-300/70">
                                        UAL: {publishedUAL}
                                    </div>
                                    <div className="text-[10px] text-emerald-400 mt-1">
                                        Added to Global Firewall (Poison Pill Active)
                                    </div>
                                </div>
                            ) : (
                                <button
                                    onClick={publishPatch}
                                    disabled={publishStatus === 'publishing'}
                                    className="w-full md:w-auto px-6 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg text-white font-medium transition-all flex items-center justify-center gap-2"
                                >
                                    {publishStatus === 'publishing' ? (
                                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-cyan-500 border-t-transparent"></div>
                                    ) : (
                                        <Share2 size={18} />
                                    )}
                                    {publishStatus === 'publishing' ? "Minting Asset..." : "Mint Truth Patch"}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </motion.div>
        )}
    </div>
  );
}

function AgentView() {
  const [messages, setMessages] = useState([
    { id: 1, role: 'assistant', text: 'Hello. I am a standard AI Assistant connected to the internet. Ask me anything.' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg = { id: Date.now(), role: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
        const res = await axios.post(`${API_URL}/api/agent-guard`, { question: userMsg.text });

        if (res.data.blocked) {
            setMessages(prev => [...prev, {
                id: Date.now() + 1,
                role: 'system',
                text: `⛔ BLOCKED: ${res.data.reason}`
            }]);
        } else {
            setMessages(prev => [...prev, {
                id: Date.now() + 1,
                role: 'assistant',
                text: res.data.answer || "No response received."
            }]);
        }

    } catch (err) {
        console.error("Agent Error:", err);
        setMessages(prev => [...prev, {
            id: Date.now() + 1,
            role: 'system',
            text: "⚠️ System Error: Unable to contact Agent Guard."
        }]);
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto h-[600px] flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="bg-slate-800 p-4 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
                <span className="font-mono text-sm text-slate-300">Agent Status: ONLINE</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-cyan-400 bg-cyan-950/50 px-2 py-1 rounded border border-cyan-900">
                <Shield size={12} />
                Community Lens Active
            </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-slate-950/50">
            {messages.map(msg => (
                <div key={msg.id} className={clsx(
                    "flex",
                    msg.role === 'user' ? "justify-end" : "justify-start"
                )}>
                    <div className={clsx(
                        "max-w-[80%] rounded-lg p-3 text-sm",
                        msg.role === 'user' ? "bg-blue-600 text-white" :
                        msg.role === 'system' ? "bg-red-900/20 border border-red-500/50 text-red-200" : "bg-slate-800 text-slate-300"
                    )}>
                        {msg.text}
                    </div>
                </div>
            ))}
            {loading && (
                 <div className="flex justify-start">
                    <div className="bg-slate-800 text-slate-300 max-w-[80%] rounded-lg p-3 text-sm flex gap-1 items-center">
                        <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"></span>
                        <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-75"></span>
                        <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-150"></span>
                    </div>
                </div>
            )}
        </div>

        <form onSubmit={handleSend} className="p-4 bg-slate-800 border-t border-slate-700 flex gap-3">
            <input
                type="text"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-cyan-500"
                placeholder="Type a message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" disabled={loading} className="bg-cyan-600 hover:bg-cyan-500 text-white p-2 rounded-lg transition-colors disabled:opacity-50">
                <MessageSquare size={20} />
            </button>
        </form>
    </div>
  );
}

export default App;
