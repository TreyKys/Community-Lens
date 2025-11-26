import React, { useState } from 'react';
import BountyBoard from './components/BountyBoard';
import VerificationTerminal from './components/VerificationTerminal';
import AgentGuard from './components/AgentGuard';

function App() {
  const [currentView, setCurrentView] = useState('bountyBoard');
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [mintedAsset, setMintedAsset] = useState(null);

  const handleBountySelect = (topic) => {
    setSelectedTopic(topic);
    setCurrentView('terminal');
  };

  const handleMintingComplete = (asset) => {
    setMintedAsset(asset);
    setSelectedTopic(null);
    setCurrentView('agentGuard'); // Switch to agent guard to show the new note
  };

  const handleReturnToBounties = () => {
    setSelectedTopic(null);
    setCurrentView('bountyBoard');
  }

  const renderView = () => {
    switch (currentView) {
      case 'terminal':
        return (
          <VerificationTerminal
            topic={selectedTopic}
            onMintingComplete={handleMintingComplete}
            onReturn={handleReturnToBounties}
          />
        );
      case 'agentGuard':
        return <AgentGuard mintedAsset={mintedAsset} />;
      case 'bountyBoard':
      default:
        return <BountyBoard onSelect={handleBountySelect} />;
    }
  };

  return (
    <div className="bg-slate-900 text-white min-h-screen font-sans">
      <header className="bg-slate-800 p-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-cyan-500">Community Lens 3.0</h1>
        <nav className="flex space-x-4">
          <button
            onClick={() => setCurrentView('bountyBoard')}
            className={`px-4 py-2 rounded ${currentView === 'bountyBoard' ? 'bg-cyan-500' : 'bg-slate-700 hover:bg-slate-600'}`}
          >
            Bounty Board
          </button>
          <button
            onClick={() => setCurrentView('agentGuard')}
            className={`px-4 py-2 rounded ${currentView === 'agentGuard' ? 'bg-cyan-500' : 'bg-slate-700 hover:bg-slate-600'}`}
          >
            Agent Guard
          </button>
        </nav>
      </header>
      <main className="p-8">
        {renderView()}
      </main>
    </div>
  );
}

export default App;
