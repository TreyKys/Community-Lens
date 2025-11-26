import React, { useState } from 'react';

function AgentGuard({ mintedAsset }) {
  const [topic, setTopic] = useState('');
  const [response, setResponse] = useState(null);
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

  const checkTopic = async () => {
    const res = await fetch(`${API_URL}/api/agent-guard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
    const data = await res.json();
    setResponse(data);
  };

  return (
    <div className="mt-8 pt-8 border-t border-slate-700">
      <h2 className="text-2xl font-bold text-center text-emerald-500 mb-4">Agent Guard</h2>
      <div className="max-w-md mx-auto bg-slate-800 p-4 rounded-lg">
        <div className="flex space-x-2">
          <input
            type="text"
            className="w-full bg-slate-900 p-2 rounded"
            placeholder="Ask about a topic..."
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <button onClick={checkTopic} className="bg-emerald-500 px-4 py-2 rounded-lg hover:bg-emerald-600">
            Ask
          </button>
        </div>
        {response && (
          <div className="mt-4 p-2 bg-slate-900 rounded">
            {response.blocked ? (
              <p className="text-red-400">
                ⛔ BLOCKED: Community Note {response.assetId} flags this information as inaccurate.
              </p>
            ) : (
              <p className="text-green-400">✅ This topic is not currently flagged.</p>
            )}
          </div>
        )}
        {mintedAsset && (
            <div className="mt-4 p-2 bg-green-900 rounded">
                <p className="text-green-300">
                New Community Note Minted: {mintedAsset.ual}
                </p>
            </div>
        )}
      </div>
    </div>
  );
}

export default AgentGuard;
