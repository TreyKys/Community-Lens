import React, { useState, useEffect } from 'react';
import { Shield, MessageSquare, Zap } from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { db, fetchGrokSource, fetchConsensus, analyzeDiscrepancy, mintCommunityNote, agentGuard } from './firebase';
import { collection, onSnapshot, query } from 'firebase/firestore';

function App() {
  const [activeTab, setActiveTab] = useState('bounty'); // 'bounty' | 'verifier' | 'agent'
  const [selectedBounty, setSelectedBounty] = useState(null);

  const viewVerifier = (bounty) => {
    setSelectedBounty(bounty);
    setActiveTab('verifier');
  }

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
              Community Lens <span className="text-cyan-500">Firebase</span>
            </h1>
            <div className="flex gap-2 text-xs mt-1">
              <span className="bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">Firestore Backend</span>
              <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded border border-blue-500/30">DKG Connected</span>
            </div>
          </div>
        </div>

        <nav className="flex bg-slate-900 rounded-lg p-1 border border-slate-800">
          <button
            onClick={() => setActiveTab('bounty')}
            className={clsx(
              "px-4 py-2 text-sm font-medium rounded-md transition-all",
              activeTab === 'bounty' ? "bg-slate-800 text-cyan-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
            )}
          >
            Bounty Board
          </button>
          <button
            onClick={() => setActiveTab('verifier')}
            className={clsx(
              "px-4 py-2 text-sm font-medium rounded-md transition-all",
              activeTab === 'verifier' ? "bg-slate-800 text-cyan-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
            )}
          >
            Verification Terminal
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
        {activeTab === 'bounty' && <BountyBoardView onViewBounty={viewVerifier} />}
        {activeTab === 'verifier' && <VerifierView bounty={selectedBounty} />}
        {activeTab === 'agent' && <AgentView />}
      </main>
    </div>
  );
}

function BountyBoardView({ onViewBounty }) {
    const [bounties, setBounties] = useState([]);

    useEffect(() => {
        const q = query(collection(db, "bounties"));
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            const bountiesData = [];
            querySnapshot.forEach((doc) => {
                bountiesData.push({ id: doc.id, ...doc.data() });
            });
            setBounties(bountiesData);
        });
        return () => unsubscribe();
    }, []);

    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-bold text-white">Bounty Board</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {bounties.map(bounty => (
                    <motion.div
                        key={bounty.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: bounties.indexOf(bounty) * 0.1 }}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col"
                    >
                        <div className="flex justify-between items-start">
                             <span className={clsx(
                                "px-2 py-1 text-xs font-bold uppercase rounded-full",
                                bounty.context.toLowerCase().includes('medical') || bounty.topic.toLowerCase().includes('vaccine') ? "bg-blue-500/20 text-blue-300" : "bg-purple-500/20 text-purple-300"
                            )}>
                                {bounty.context.toLowerCase().includes('medical') || bounty.topic.toLowerCase().includes('vaccine') ? 'Medical' : 'General'}
                            </span>
                             <span className="text-lg font-bold text-cyan-400">{bounty.reward} TRAC</span>
                        </div>
                        <h3 className="text-xl font-semibold mt-4">{bounty.topic}</h3>
                        <p className="text-slate-400 text-sm mt-2 flex-grow">{bounty.context}</p>
                        <button
                            onClick={() => onViewBounty(bounty)}
                            className="mt-6 w-full bg-slate-800 hover:bg-slate-700 text-white font-medium py-2 rounded-lg transition-colors"
                        >
                            Verify
                        </button>
                    </motion.div>
                ))}
            </div>
        </div>
    );
}


function VerifierView({ bounty }) {
  const [topicInput, setTopicInput] = useState('');
  const [suspectText, setSuspectText] = useState('');
  const [consensusText, setConsensusText] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(''); // 'grok', 'consensus', 'analysis'
  const [publishStatus, setPublishStatus] = useState(null);
  const [stakeAmount, setStakeAmount] = useState(500);
  const [publishedUAL, setPublishedUAL] = useState('');
  const [consensusMode, setConsensusMode] = useState('general'); // 'general' | 'medical'
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (bounty) {
      setTopicInput(bounty.topic);
      setSuspectText(bounty.grokText || '');
      if (bounty.context.toLowerCase().includes('medical') || bounty.topic.toLowerCase().includes('vaccine')) {
        setConsensusMode('medical');
      }
    }
  }, [bounty]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleFetchGrok = async () => {
    if (!topicInput) return;
    setLoading('grok');
    try {
      // Simulate url construction for the scraper
      const url = `https://grokipedia.x.ai/topic/${encodeURIComponent(topicInput)}`;
      const result = await fetchGrokSource({ url });

      if (result.data.manual_required) {
         setToast({ type: 'warning', message: "⚠️ Grok Shield Detected. Switching to Manual Mode." });
         // Logic to 'unlock' or focus could go here, but since it's already editable, the toast is the key feedback.
      } else if (result.data.text) {
         setSuspectText(result.data.text);
         setToast({ type: 'success', message: "Source fetched successfully." });
      }
    } catch (err) {
       console.error(err);
       // Fallback for unexpected errors
       setToast({ type: 'warning', message: "⚠️ Connection Failed. Switching to Manual Mode." });
    } finally {
      setLoading('');
    }
  }

  const handleFetchConsensus = async () => {
    if (!topicInput) return;
    setLoading('consensus');
    try {
        const result = await fetchConsensus({ topic: topicInput, mode: consensusMode });
        setConsensusText(result.data.consensusText);
    } catch (err) {
        console.error(err);
    } finally {
        setLoading('');
    }
  };

  const runAnalysis = async () => {
    if (!suspectText || !consensusText) return;
    setLoading('analysis');
    try {
      const result = await analyzeDiscrepancy({
        suspectText,
        consensusText,
      });
      setAnalysis(result.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading('');
    }
  };

    const publishPatch = async () => {
    if (!analysis) return;
    setPublishStatus('publishing');
    try {
        const result = await mintCommunityNote({
            topic: topicInput,
            claim: suspectText,
            analysis,
            stake: stakeAmount
        });
        setPublishStatus('success');
        setPublishedUAL(result.data.assetId);
    } catch (err) {
        console.error(err);
        setPublishStatus('error');
    }
  };

  return (
    <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Suspect Source */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col h-[400px]">
                <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <h3 className="font-semibold text-red-400">Grokipedia Source</h3>
                    <button
                      onClick={handleFetchGrok}
                      disabled={loading === 'grok' || !topicInput}
                      className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-xs px-2 py-1 rounded transition-colors border border-slate-700"
                    >
                      <Zap size={12} className={loading === 'grok' ? "animate-pulse text-yellow-400" : "text-yellow-400"} />
                      {loading === 'grok' ? 'Fetching...' : 'Auto-Fetch Grok'}
                    </button>
                </div>
                <div className="flex-1 p-4 bg-slate-900/50 relative">
                     <textarea
                        className="w-full h-full bg-transparent resize-none focus:outline-none text-slate-300 placeholder:text-slate-600"
                        placeholder="Paste Grokipedia text here..."
                        value={suspectText}
                        onChange={(e) => setSuspectText(e.target.value)}
                        disabled={loading === 'grok'}
                    />
                    {/* Toast Overlay */}
                    <AnimatePresence>
                      {toast && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className={clsx(
                            "absolute bottom-4 left-4 right-4 p-3 rounded-lg text-sm font-medium border shadow-lg backdrop-blur-md",
                            toast.type === 'warning' ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-200" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                          )}
                        >
                          {toast.message}
                        </motion.div>
                      )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Trusted Source */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col h-[400px]">
                <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <h3 className="font-semibold text-emerald-400">Consensus Source</h3>
                    <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700">
                         <button onClick={() => setConsensusMode('general')} className={clsx("px-2 py-1 text-xs rounded", consensusMode === 'general' ? 'bg-slate-700 text-white' : 'text-slate-400')}>General (Wiki)</button>
                         <button onClick={() => setConsensusMode('medical')} className={clsx("px-2 py-1 text-xs rounded", consensusMode === 'medical' ? 'bg-slate-700 text-white' : 'text-slate-400')}>Medical (Wiki + PubMed)</button>
                    </div>
                </div>
                <div className="flex-1 p-4 bg-slate-900/50">
                    <textarea
                        className="w-full h-full bg-transparent resize-none focus:outline-none text-slate-300"
                        placeholder="Consensus text will appear here..."
                        value={consensusText}
                        readOnly
                    />
                </div>
            </div>
        </div>

        {/* Action Bar */}
        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between gap-4">
            <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="Enter topic..."
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2"
            />
            <button onClick={handleFetchConsensus} disabled={!topicInput || loading === 'consensus'} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg">
                {loading === 'consensus' ? 'Fetching...' : 'Fetch Consensus'}
            </button>
            <button onClick={runAnalysis} disabled={!suspectText || !consensusText || loading === 'analysis'} className="bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg">
                {loading === 'analysis' ? 'Analyzing...' : 'RUN ANALYSIS'}
            </button>
        </div>

        {analysis && (
             <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-slate-900 border border-slate-800 rounded-xl p-6"
            >
                {/* Score & Discrepancies */}
                <div className="flex gap-8">
                     <div className="text-center">
                         <div className="text-sm text-slate-400">Alignment Score</div>
                         <div className={clsx("text-6xl font-black", analysis.score > 80 ? "text-emerald-400" : "text-yellow-400")}>
                             {analysis.score}
                         </div>
                     </div>
                     <div className="flex-1">
                        <h4 className="text-sm font-semibold">Discrepancies</h4>
                        <div className="space-y-2 mt-2">
                        {analysis.discrepancies.map((d, i) => (
                            <div key={i} className="bg-slate-800 p-2 rounded text-sm">
                                <span className="font-bold text-red-400">{d.type}:</span> {d.text}
                            </div>
                        ))}
                        </div>
                     </div>
                </div>

                {/* Staking & Publishing */}
                <div className="mt-8 pt-6 border-t border-slate-800 flex justify-between items-center">
                     <div>
                         <label>Stake TRAC</label>
                         <input type="range" min="10" max="1000" value={stakeAmount} onChange={e => setStakeAmount(e.target.value)} />
                         <span>{stakeAmount} TRAC</span>
                     </div>
                     {publishStatus === 'success' ? (
                        <div className="text-emerald-400">Minted: {publishedUAL}</div>
                     ) : (
                        <button onClick={publishPatch} disabled={publishStatus === 'publishing'} className="bg-slate-800 px-6 py-3 rounded-lg">
                            {publishStatus === 'publishing' ? 'Minting...' : 'MINT COMMUNITY NOTE'}
                        </button>
                     )}
                </div>
            </motion.div>
        )}
    </div>
  );
}


function AgentView() {
  const [messages, setMessages] = useState([
    { id: 1, role: 'assistant', text: 'Ask me anything.' }
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
        const result = await agentGuard({ question: userMsg.text });
        const assistantMsg = { id: Date.now() + 1, role: result.data.blocked ? 'system' : 'assistant', text: result.data.message };
        setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
        setMessages(prev => [...prev, { id: Date.now() + 1, role: 'system', text: "Error contacting agent." }]);
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto h-[600px] flex flex-col bg-slate-900 border border-slate-800 rounded-xl">
        <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {messages.map(msg => (
                <div key={msg.id} className={clsx("flex", msg.role === 'user' ? "justify-end" : "justify-start")}>
                    <div className={clsx("max-w-[80%] rounded-lg p-3", msg.role === 'user' ? "bg-blue-600" : msg.role === 'system' ? "bg-red-800" : "bg-slate-700")}>
                        {msg.text}
                    </div>
                </div>
            ))}
        </div>
        <form onSubmit={handleSend} className="p-4 bg-slate-800 border-t border-slate-700 flex gap-3">
            <input
                type="text"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2"
                value={input}
                onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" disabled={loading} className="bg-cyan-600 p-2 rounded-lg">
                <MessageSquare />
            </button>
        </form>
    </div>
  );
}

export default App;
