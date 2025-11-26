import React, { useState } from 'react';
import BountyBoard from './components/BountyBoard';
import VerificationTerminal from './components/VerificationTerminal';
import AgentGuard from './components/AgentGuard';

function App() {
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [mintedAsset, setMintedAsset] = useState(null);

  const handleBountySelect = (topic) => {
    setSelectedTopic(topic);
  };

  const handleMintingComplete = (asset) => {
    setMintedAsset(asset);
    setSelectedTopic(null); // Return to bounty board
  };

  return (
    <div className="bg-slate-900 text-white min-h-screen font-sans">
      <header className="bg-slate-800 p-4 text-center">
        <h1 className="text-2xl font-bold text-emerald-500">Community Lens 3.0</h1>
      </header>
      <main className="p-8">
        {!selectedTopic && <BountyBoard onSelect={handleBountySelect} />}
        {selectedTopic && !mintedAsset && (
          <VerificationTerminal
            topic={selectedTopic}
            onMintingComplete={handleMintingComplete}
          />
        )}
        <AgentGuard mintedAsset={mintedAsset} />
      </main>
    </div>
  );
}

export default App;
