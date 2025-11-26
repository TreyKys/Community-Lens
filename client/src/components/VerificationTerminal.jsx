import React, { useState } from 'react';

function VerificationTerminal({ topic, onMintingComplete, onReturn }) {
  const [suspectText, setSuspectText] = useState('');
  const [consensusText, setConsensusText] = useState('');
  const [source, setSource] = useState('wikipedia');
  const [analysis, setAnalysis] = useState(null);
  const [manualMode, setManualMode] = useState(false);
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

  const fetchGrok = async () => {
    const response = await fetch(`${API_URL}/api/fetch-grok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
    const data = await response.json();
    if (data.manual_required) {
      setManualMode(true);
      alert('API Quota Exceeded: Switched to Manual Input Mode');
    } else {
      setSuspectText(data.content);
    }
  };

  const fetchConsensus = async () => {
    const response = await fetch(`${API_URL}/api/fetch-consensus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, source }),
    });
    const data = await response.json();
    setConsensusText(data.content);
  };

  const runAnalysis = async () => {
    const response = await fetch(`${API_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suspectText, consensusText }),
    });
    const data = await response.json();
    setAnalysis(data);
  };

  const mintNote = async () => {
    const response = await fetch(`${API_URL}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { topic, analysis } }),
    });
    const result = await response.json();
    onMintingComplete(result);
  };


  return (
    <div className="space-y-6">
        <div className="flex justify-between items-center">
            <button onClick={onReturn} className="bg-slate-700 px-4 py-2 rounded-lg hover:bg-slate-600">
                &larr; Back to Bounties
            </button>
            <h2 className="text-2xl font-bold text-center text-cyan-500">{topic}</h2>
            <div className="w-36"></div> {/* Spacer */}
        </div>
      <div className="grid grid-cols-2 gap-6">
        {/* Suspect Column */}
        <div className="bg-slate-800 p-4 rounded-lg">
          <h3 className="text-lg font-bold mb-2">Grokipedia Source</h3>
          <button onClick={fetchGrok} className="bg-cyan-500 px-4 py-2 rounded-lg hover:bg-cyan-600">
            ⚡ Fetch from xAI
          </button>
          {manualMode ? (
            <textarea
              className="w-full h-64 mt-4 bg-slate-900 p-2 rounded"
              value={suspectText}
              onChange={(e) => setSuspectText(e.target.value)}
            />
          ) : (
            <div className="mt-4 p-2 bg-slate-900 rounded h-64 overflow-y-auto">{suspectText}</div>
          )}
        </div>

        {/* Consensus Column */}
        <div className="bg-slate-800 p-4 rounded-lg">
          <h3 className="text-lg font-bold mb-2">Consensus Source</h3>
          <div className="flex space-x-2 mb-2">
            <button onClick={() => setSource('wikipedia')} className={`px-4 py-2 rounded-lg ${source === 'wikipedia' ? 'bg-cyan-500' : 'bg-slate-700'}`}>Wikipedia</button>
            <button onClick={() => setSource('pubmed')} className={`px-4 py-2 rounded-lg ${source === 'pubmed' ? 'bg-cyan-500' : 'bg-slate-700'}`}>PubMed</button>
          </div>
          <button onClick={fetchConsensus} className="bg-cyan-500 px-4 py-2 rounded-lg hover:bg-cyan-600">
            🔍 Fetch Consensus
          </button>
          <div className="mt-4 p-2 bg-slate-900 rounded h-64 overflow-y-auto">{consensusText}</div>
        </div>
      </div>

      <div className="text-center">
        <button onClick={runAnalysis} className="bg-cyan-500 px-6 py-3 rounded-lg text-xl hover:bg-cyan-600">
          RUN ANALYSIS
        </button>
      </div>

      {analysis && (
        <div className="bg-slate-800 p-4 rounded-lg">
          <h3 className="text-lg font-bold">Analysis Result</h3>
          <p>Alignment Score: {analysis.score}</p>
          <p>{analysis.analysis}</p>
          <div className="mt-4">
            <h4 className="font-bold">Discrepancies:</h4>
            <ul className="list-disc pl-5">
              {analysis.discrepancies.map((d, i) => (
                <li key={i} className={d.type === 'Hallucination' ? 'text-red-400' : 'text-yellow-400'}>
                  <strong>{d.type}:</strong> {d.text}
                </li>
              ))}
            </ul>
          </div>
          <div className="text-center mt-6">
            <button onClick={mintNote} className="bg-blue-500 px-6 py-3 rounded-lg text-xl hover:bg-blue-600">
              MINT COMMUNITY NOTE
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default VerificationTerminal;
